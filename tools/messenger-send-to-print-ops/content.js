/**
 * Content script: full-thread scrape for mock Messenger + best-effort messenger.com.
 * Auto-scrolls the selected conversation so older bubbles load before extract.
 */
(() => {
  if (window.__printOpsMessengerScanInstalled) return;
  window.__printOpsMessengerScanInstalled = true;

  const NOISE_RE =
    /^(?:you sent|enter|delivery|reacted|liked a message|sent an attachment|today|yesterday|\d{1,2}:\d{2}\s*(?:am|pm)?)$/i;

  function cleanBubbleText(raw) {
    return String(raw || "")
      .replace(/\u200b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isNoiseBubble(text) {
    const cleaned = cleanBubbleText(text);
    if (!cleaned) return true;
    if (cleaned.length <= 2 && !/[a-z0-9]/i.test(cleaned)) return true;
    return NOISE_RE.test(cleaned);
  }

  function formatMessengerThread(bubbles, options = {}) {
    const lines = [];
    const title = cleanBubbleText(options.title || "");
    if (title) lines.push(`Thread: ${title}`);
    for (const bubble of bubbles) {
      const text = cleanBubbleText(bubble.text);
      if (isNoiseBubble(text)) continue;
      const label =
        bubble.speaker === "you" ? "You" : bubble.speaker === "buyer" ? "Buyer" : "Message";
      lines.push(`${label}: ${text}`);
    }
    return lines.join("\n").trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findThreadRoot() {
    return (
      document.querySelector("[data-print-ops-thread]") ||
      document.querySelector('[role="main"] [role="log"]') ||
      document.querySelector('[role="main"] div[data-pagelet*="MWThread"]') ||
      document.querySelector("div[aria-label='Messages']") ||
      document.querySelector("div[aria-label*='Conversation']") ||
      null
    );
  }

  function findScrollContainer(threadRoot) {
    if (!threadRoot) return null;
    if (threadRoot.getAttribute("data-print-ops-thread") != null) return threadRoot;
    let node = threadRoot;
    for (let i = 0; i < 8 && node; i++) {
      const style = window.getComputedStyle(node);
      const scrollable =
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        node.scrollHeight > node.clientHeight + 20;
      if (scrollable) return node;
      node = node.parentElement;
    }
    return threadRoot;
  }

  function threadTitle() {
    const mock = document.querySelector("[data-print-ops-thread-title]");
    if (mock) return cleanBubbleText(mock.textContent || "");
    const heading =
      document.querySelector("h1") ||
      document.querySelector('[role="main"] h2') ||
      document.querySelector("header h1");
    return cleanBubbleText(heading?.textContent || document.title || "");
  }

  function collectBubbles(threadRoot) {
    const mockNodes = threadRoot.querySelectorAll("[data-print-ops-message]");
    if (mockNodes.length) {
      return Array.from(mockNodes).map((row) => {
        const bubble = row.querySelector("[data-print-ops-bubble]") || row;
        const outgoing = row.getAttribute("data-outgoing") === "true";
        return {
          speaker: outgoing ? "you" : "buyer",
          text: cleanBubbleText(bubble.textContent || ""),
        };
      });
    }

    // Best-effort Messenger DOM: prefer obvious message rows.
    const candidates = threadRoot.querySelectorAll(
      'div[dir="auto"], div[data-scope="messages_table"] div, div[role="row"]',
    );
    const bubbles = [];
    const seen = new Set();
    for (const el of candidates) {
      const text = cleanBubbleText(el.textContent || "");
      if (!text || text.length > 4000 || isNoiseBubble(text)) continue;
      // Skip containers that only wrap many nested bubbles.
      if (el.querySelectorAll('div[dir="auto"]').length > 2) continue;
      const key = text.slice(0, 180);
      if (seen.has(key)) continue;
      seen.add(key);

      const outgoingHint =
        el.closest('[data-scope*="outgoing"]') != null ||
        /you sent/i.test(el.parentElement?.textContent || "");
      const rowText = el.parentElement?.textContent || "";
      let speaker = "unknown";
      if (outgoingHint) speaker = "you";
      else if (rowText && !/you sent/i.test(rowText)) speaker = "buyer";

      bubbles.push({ speaker, text });
    }
    return bubbles;
  }

  async function loadFullThread(scrollEl, options = {}) {
    const maxScrolls = options.maxScrolls ?? 120;
    const settleMs = options.settleMs ?? 450;
    let stableRounds = 0;
    let lastCount = collectBubbles(findThreadRoot() || scrollEl).length;
    let lastHeight = scrollEl.scrollHeight;

    for (let i = 0; i < maxScrolls; i++) {
      // Nudge upward in chunks — Messenger often virtualizes and ignores a single jump to 0.
      const step = Math.max(400, Math.floor(scrollEl.clientHeight * 0.85));
      scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop - step);
      if (scrollEl.scrollTop <= 2) scrollEl.scrollTop = 0;
      scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(settleMs);

      const root = findThreadRoot() || scrollEl;
      const count = collectBubbles(root).length;
      const height = scrollEl.scrollHeight;
      if (count <= lastCount && height <= lastHeight && scrollEl.scrollTop <= 2) {
        stableRounds += 1;
        if (stableRounds >= 4) break;
      } else {
        stableRounds = 0;
        lastCount = Math.max(lastCount, count);
        lastHeight = Math.max(lastHeight, height);
      }
    }

    // Return to bottom for normal reading.
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  async function scrapeSelectedThread() {
    const threadRoot = findThreadRoot();
    if (!threadRoot) {
      throw new Error(
        "No conversation pane found. Open a thread first (or use /dev/mock-messenger for the test UI).",
      );
    }
    const scrollEl = findScrollContainer(threadRoot);
    if (scrollEl) await loadFullThread(scrollEl);

    const root = findThreadRoot() || threadRoot;
    const bubbles = collectBubbles(root);
    const conversation = formatMessengerThread(bubbles, { title: threadTitle() });
    if (conversation.length < 20) {
      throw new Error("Could not read enough message text from this thread.");
    }
    return {
      conversation,
      title: threadTitle(),
      bubbleCount: bubbles.length,
      href: location.href,
    };
  }

  function ensureFab() {
    if (document.getElementById("print-ops-messenger-scan-fab")) return;
    const btn = document.createElement("button");
    btn.id = "print-ops-messenger-scan-fab";
    btn.type = "button";
    btn.textContent = "Send to Print Ops";
    Object.assign(btn.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483646",
      border: "none",
      borderRadius: "999px",
      padding: "10px 14px",
      font: "650 13px/1.2 Segoe UI, system-ui, sans-serif",
      color: "#fff",
      background: "#0a7c4a",
      boxShadow: "0 8px 24px rgba(0,0,0,.18)",
      cursor: "pointer",
    });
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "print-ops-scan-request" });
    });
    document.documentElement.appendChild(btn);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "print-ops-scrape-thread") return;
    scrapeSelectedThread()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });

  ensureFab();
})();
