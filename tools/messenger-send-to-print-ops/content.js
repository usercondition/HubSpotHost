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

  function normalizedThreadName(value) {
    return cleanBubbleText(value)
      .replace(/\(marketplace\)/gi, "")
      .replace(/[^a-z0-9\s]/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  // Do not use partial-name matching here: sending a shipping notice to a
  // similarly named buyer is worse than leaving the request pending.
  function exactThreadMatch(title, recipient) {
    return normalizedThreadName(title) === normalizedThreadName(recipient);
  }

  function listedThreadItems() {
    const listRoot =
      document.querySelector("[data-print-ops-thread-list]") ||
      document.querySelector('[aria-label="Chats"]') ||
      document.querySelector('[aria-label*="Conversations"]') ||
      document.querySelector('div[role="navigation"]');
    if (!listRoot) return [];
    return Array.from(
      listRoot.querySelectorAll(
        '[data-print-ops-thread-item], a[role="link"], div[role="row"], div[role="listitem"]',
      ),
    );
  }

  function listedThreadTitle(el) {
    return cleanBubbleText(
      el.querySelector(".name span, span, strong")?.textContent || el.getAttribute("aria-label") || "",
    );
  }

  async function openMarketplaceThread(recipient) {
    if (!recipient || normalizedThreadName(recipient).length < 2) {
      throw new Error("Queued shipment has no buyer name; it was not sent.");
    }
    if (typeof window.__mockMarketplaceInbox?.openThreadByName === "function") {
      if (window.__mockMarketplaceInbox.openThreadByName(recipient)) {
        await sleep(50);
        return;
      }
      throw new Error(`Could not find Marketplace chat for "${recipient}", including archived chats. Request left pending.`);
    }

    const clickMatchingThread = () => {
      const hit = listedThreadItems().find((item) => exactThreadMatch(listedThreadTitle(item), recipient));
      if (hit) hit.click();
      return Boolean(hit);
    };
    if (clickMatchingThread()) {
      await sleep(700);
      if (exactThreadMatch(threadTitle(), recipient)) return;
    }

    // Messenger's archive is normally a navigation item. Open it before
    // searching; search result titles still must exactly match the recipient.
    const archived = Array.from(
      document.querySelectorAll('[aria-label*="Archived" i], [title*="Archived" i], a[href*="archived" i]'),
    ).find((el) => /archived/i.test(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || ""));
    if (archived) {
      archived.click();
      await sleep(900);
      if (clickMatchingThread()) {
        await sleep(700);
        if (exactThreadMatch(threadTitle(), recipient)) return;
      }
    }

    const search = document.querySelector(
      'input[placeholder*="Search" i], input[aria-label*="Search" i], [role="searchbox"]',
    );
    if (search) {
      search.focus();
      search.value = recipient;
      search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: recipient }));
      search.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(900);
      if (clickMatchingThread()) {
        await sleep(700);
        if (exactThreadMatch(threadTitle(), recipient)) return;
      }
    }
    throw new Error(`Could not find an exact Marketplace chat for "${recipient}", including archived chats. Request left pending.`);
  }

  async function sendMarketplaceMessage(recipient, text) {
    await openMarketplaceThread(recipient);
    if (!exactThreadMatch(threadTitle(), recipient)) {
      throw new Error(`Opened chat does not exactly match "${recipient}"; request left pending.`);
    }
    const composer = document.querySelector(
      '[data-print-ops-composer], [contenteditable="true"][role="textbox"], [contenteditable="true"][aria-label*="Message" i], textarea[aria-label*="Message" i]',
    );
    if (!composer) throw new Error("Could not find the message composer; request left pending.");
    composer.focus();
    if (composer.getAttribute("contenteditable") === "true") {
      document.execCommand("insertText", false, text);
    } else {
      composer.value = text;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await sleep(50);
    const send = document.querySelector(
      '[data-print-ops-send], [aria-label="Send" i], [title="Send" i], button[type="submit"]',
    );
    if (send) send.click();
    else {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    }
    await sleep(350);
    return { title: threadTitle() };
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

  /**
   * Prefer mock inbox dump; else click through listed chats (best-effort).
   */
  async function scrapeInboxThreads(options = {}) {
    const maxThreads = options.maxThreads ?? 20;

    if (typeof window.__mockMarketplaceInbox?.listThreads === "function") {
      const listed = window.__mockMarketplaceInbox.listThreads().slice(0, maxThreads);
      return {
        threads: listed.map((row) => ({
          id: row.id,
          title: row.title,
          unread: Boolean(row.unread),
          conversation: row.conversation,
        })),
        source: "mock-inbox",
      };
    }

    const listRoot =
      document.querySelector("[data-print-ops-thread-list]") ||
      document.querySelector('[aria-label="Chats"]') ||
      document.querySelector('[aria-label*="Conversations"]') ||
      document.querySelector('div[role="navigation"]');

    const items = listRoot
      ? Array.from(
          listRoot.querySelectorAll(
            '[data-print-ops-thread-item], a[role="link"], div[role="row"], div[role="listitem"]',
          ),
        )
      : [];

    const picks = [];
    const seen = new Set();
    for (const el of items) {
      const title = cleanBubbleText(
        el.querySelector(".name span, span, strong")?.textContent || el.getAttribute("aria-label") || "",
      );
      if (!title || title.length < 2 || seen.has(title)) continue;
      // Skip obvious chrome.
      if (/^(chats|marketplace|inbox|filtered|messages)$/i.test(title)) continue;
      seen.add(title);
      const unread =
        el.getAttribute("data-unread") === "true" ||
        Boolean(el.querySelector('[aria-label*="unread" i], .dot')) ||
        /unread/i.test(el.getAttribute("aria-label") || "");
      picks.push({ el, title, unread });
      if (picks.length >= maxThreads) break;
    }

    if (!picks.length) {
      // Fallback: brief the open thread only.
      const one = await scrapeSelectedThread();
      return {
        threads: [
          {
            id: one.href || "open-thread",
            title: one.title,
            unread: false,
            conversation: one.conversation,
          },
        ],
        source: "open-thread-fallback",
      };
    }

    // Unread first.
    picks.sort((a, b) => Number(b.unread) - Number(a.unread));

    const threads = [];
    for (const pick of picks) {
      try {
        pick.el.click();
        await sleep(700);
        const scraped = await scrapeSelectedThread();
        threads.push({
          id: pick.title,
          title: scraped.title || pick.title,
          unread: pick.unread,
          conversation: scraped.conversation,
        });
      } catch {
        // Skip stubborn rows.
      }
    }

    if (!threads.length) {
      throw new Error("Could not read any inbox threads. Open Messenger and try again.");
    }
    return { threads, source: "inbox-clickthrough" };
  }

  function ensureFab() {
    if (document.getElementById("print-ops-messenger-scan-fab")) return;
    const wrap = document.createElement("div");
    wrap.id = "print-ops-messenger-scan-fab";
    Object.assign(wrap.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483646",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
    });

    function makeBtn(label, type, primary) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      Object.assign(btn.style, {
        border: "none",
        borderRadius: "999px",
        padding: "10px 14px",
        font: "650 13px/1.2 Segoe UI, system-ui, sans-serif",
        color: primary ? "#fff" : "#0a7c4a",
        background: primary ? "#0a7c4a" : "#eef6f1",
        boxShadow: "0 8px 24px rgba(0,0,0,.18)",
        cursor: "pointer",
      });
      btn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type });
      });
      return btn;
    }

    wrap.appendChild(makeBtn("Inbox brief", "print-ops-inbox-brief", true));
    wrap.appendChild(makeBtn("This thread → Manual", "print-ops-scan-request", false));
    document.documentElement.appendChild(wrap);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return;
    if (message.type === "print-ops-scrape-thread") {
      scrapeSelectedThread()
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message.type === "print-ops-scrape-inbox") {
      scrapeInboxThreads({ maxThreads: message.maxThreads || 20 })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message.type === "print-ops-send-marketplace-request") {
      sendMarketplaceMessage(message.to, message.text)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
  });

  ensureFab();
})();
