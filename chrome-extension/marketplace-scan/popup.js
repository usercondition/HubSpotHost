const DEFAULT_BASE = "http://localhost:5000";

const els = {
  baseUrl: document.getElementById("baseUrl"),
  accessCode: document.getElementById("accessCode"),
  transcript: document.getElementById("transcript"),
  counterpartName: document.getElementById("counterpartName"),
  saveWatchlist: document.getElementById("saveWatchlist"),
  status: document.getElementById("status"),
  result: document.getElementById("result"),
  scanThread: document.getElementById("scanThread"),
  scanInbox: document.getElementById("scanInbox"),
  sendScan: document.getElementById("sendScan"),
  loadFollowUps: document.getElementById("loadFollowUps"),
};

let lastScrape = {
  threadUrl: "",
  threadKey: "",
  messages: [],
};

function setStatus(text, isError = false) {
  els.status.hidden = !text;
  els.status.textContent = text || "";
  els.status.style.color = isError ? "#991b1b" : "";
}

function showHtml(html) {
  els.result.hidden = !html;
  els.result.innerHTML = html || "";
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(["baseUrl", "accessCode"]);
  els.baseUrl.value = stored.baseUrl || DEFAULT_BASE;
  els.accessCode.value = stored.accessCode || "";
}

async function saveSettings() {
  await chrome.storage.sync.set({
    baseUrl: els.baseUrl.value.trim().replace(/\/+$/, "") || DEFAULT_BASE,
    accessCode: els.accessCode.value,
  });
}

function apiBase() {
  return (els.baseUrl.value.trim() || DEFAULT_BASE).replace(/\/+$/, "");
}

function authHeaders() {
  const code = els.accessCode.value.trim();
  if (!code) throw new Error("Enter your owner access code first");
  return {
    "Content-Type": "application/json",
    "x-paid-order-access-code": code,
  };
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PRINT_OPS_PING" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

async function scrape(type) {
  const tab = await activeTab();
  if (!/facebook\.com|messenger\.com/i.test(tab.url || "")) {
    throw new Error("Open a Facebook Marketplace or Messenger tab first");
  }
  await ensureContentScript(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, { type });
  if (!response?.ok) throw new Error(response?.error || "Scrape failed");
  return response;
}

function parseTranscript(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^\[(buyer|you|system)\]\s*(.+)$/i) || line.match(/^(buyer|you|system)\s*[:\-]\s*(.+)$/i);
      if (!m) return { role: "buyer", text: line };
      return { role: m[1].toLowerCase(), text: m[2].trim() };
    })
    .filter((row) => row.text);
}

function renderScan(data) {
  const nudges = (data.nudges || [])
    .map((nudge) => {
      const reply = nudge.suggestedReply
        ? `<div class="reply"><strong>Suggested reply</strong><br />${escapeHtml(nudge.suggestedReply)}</div>`
        : "";
      return `<div class="nudge"><div class="priority-${escapeHtml(nudge.priority)}">${escapeHtml(nudge.title)}</div><div>${escapeHtml(nudge.detail)}</div>${reply}</div>`;
    })
    .join("");

  showHtml(
    `<h2>${escapeHtml(data.headline || data.stageLabel || "Scan result")}</h2>` +
      `<div><strong>Stage:</strong> ${escapeHtml(data.stageLabel || data.stage || "")}</div>` +
      `<div><strong>Waiting on:</strong> ${escapeHtml(data.waitingOn || "none")}</div>` +
      `<div><strong>Messages:</strong> ${escapeHtml(String(data.messageCount ?? ""))}` +
      (data.watchlistId ? ` · watchlist #${escapeHtml(String(data.watchlistId))}` : "") +
      `</div>` +
      nudges,
  );
}

function renderFollowUps(payload) {
  const rows = payload.followUps || [];
  if (rows.length === 0) {
    showHtml("<h2>Reminders</h2><div>No open Marketplace follow-ups yet. Scan a thread first.</div>");
    return;
  }
  showHtml(
    `<h2>Reminders (${rows.length})</h2>` +
      rows
        .map(
          (row) =>
            `<div class="nudge"><div class="priority-${row.waitingOn === "you" ? "high" : "medium"}">${escapeHtml(row.reminder)}</div>` +
            (row.suggestedReply ? `<div class="reply">${escapeHtml(row.suggestedReply)}</div>` : "") +
            `</div>`,
        )
        .join(""),
  );
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

els.scanThread.addEventListener("click", async () => {
  try {
    setStatus("Scanning open thread…");
    showHtml("");
    const scraped = await scrape("PRINT_OPS_SCRAPE_THREAD");
    lastScrape = {
      threadUrl: scraped.threadUrl || "",
      threadKey: scraped.threadKey || "",
      messages: scraped.messages || [],
    };
    els.transcript.value = scraped.labeledTranscript || "";
    if (scraped.counterpartName) els.counterpartName.value = scraped.counterpartName;
    setStatus(
      scraped.messages?.length
        ? `Captured ${scraped.messages.length} bubbles. Review labels, then Analyze + nudge.`
        : "No bubbles found — scroll the thread into view or paste a labeled transcript.",
      !scraped.messages?.length,
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Scan failed", true);
  }
});

els.scanInbox.addEventListener("click", async () => {
  try {
    await saveSettings();
    setStatus("Scanning inbox list…");
    const scraped = await scrape("PRINT_OPS_SCRAPE_INBOX");
    const items = scraped.items || [];
    if (items.length === 0) {
      setStatus("No Marketplace/Messenger inbox rows found on this page.", true);
      return;
    }
    const response = await fetch(`${apiBase()}/api/conversation-watchlist/inbox`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ items }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    setStatus(`Saved ${data.upserted} inbox rows to the watchlist.`);
    showHtml(`<h2>Inbox snapshot</h2><div>${escapeHtml(String(data.upserted))} threads saved for follow-up reminders.</div>`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Inbox scan failed", true);
  }
});

els.sendScan.addEventListener("click", async () => {
  try {
    await saveSettings();
    setStatus("Sending scan…");
    const transcript = els.transcript.value.trim();
    const messages = lastScrape.messages?.length ? lastScrape.messages : parseTranscript(transcript);
    if (messages.length === 0 && transcript.length < 8) {
      throw new Error("Scan a thread or paste a labeled transcript first");
    }
    const response = await fetch(`${apiBase()}/api/conversation-scan`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        messages,
        conversation: transcript,
        counterpartName: els.counterpartName.value.trim(),
        threadUrl: lastScrape.threadUrl || "",
        threadKey: lastScrape.threadKey || "",
        saveToWatchlist: els.saveWatchlist.checked,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    renderScan(data);
    setStatus("Scan complete.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Analyze failed", true);
  }
});

els.loadFollowUps.addEventListener("click", async () => {
  try {
    await saveSettings();
    setStatus("Loading reminders…");
    const response = await fetch(`${apiBase()}/api/conversation-watchlist?waitingOnYou=1`, {
      headers: authHeaders(),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    renderFollowUps(data);
    setStatus(`${data.waitingOnYou || 0} chat(s) waiting on you.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not load reminders", true);
  }
});

loadSettings().catch(() => {
  els.baseUrl.value = DEFAULT_BASE;
});
