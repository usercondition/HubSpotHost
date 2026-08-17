/**
 * Content script: scrape visible Marketplace / Messenger bubbles with roles.
 *
 * Meta's DOM changes often. Strategy:
 * 1) Prefer explicit message row heuristics
 * 2) Fall back to left/right bubble geometry (buyer = left, you = right)
 * 3) Always return a preview so the popup can show mistakes before send
 */
(() => {
  function clean(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isProbablyUiChrome(text) {
    if (!text || text.length < 1) return true;
    if (text.length > 1800) return true;
    return /^(like|reply|send|enter|open more|see more|marketplace|active now|online)$/i.test(text);
  }

  function counterpartFromPage() {
    const title = clean(document.title).replace(/\s*[|·-]\s*Facebook.*$/i, "");
    const heading = clean(
      document.querySelector('h1, h2, [role="main"] h2, [role="main"] span[dir="auto"]')?.textContent || "",
    );
    const candidate = heading.length >= 2 && heading.length <= 80 ? heading : title;
    if (!candidate || /marketplace|messenger|facebook|inbox/i.test(candidate)) return "";
    return candidate.slice(0, 80);
  }

  function threadKeyFromUrl(url) {
    const mp = url.match(/marketplace\/t\/([^/?#]+)/i);
    if (mp) return `mp:${mp[1]}`;
    const msg = url.match(/\/(?:messages|t)\/t\.([^/?#]+)/i);
    if (msg) return `msg:${msg[1]}`;
    return "";
  }

  function collectBubbleCandidates() {
    const roots = [
      document.querySelector('[role="main"]'),
      document.querySelector('[aria-label*="conversation" i]'),
      document.querySelector('[aria-label*="Thread" i]'),
      document.body,
    ].filter(Boolean);

    const root = roots[0] || document.body;
    const nodes = Array.from(root.querySelectorAll("div[dir='auto'], span[dir='auto']"));
    const seen = new Set();
    const bubbles = [];

    for (const node of nodes) {
      const text = clean(node.textContent);
      if (isProbablyUiChrome(text)) continue;
      // Prefer leaf-ish text nodes: skip huge containers that wrap many messages.
      if (node.querySelectorAll("div[dir='auto'], span[dir='auto']").length > 4) continue;
      const key = `${text}::${Math.round(node.getBoundingClientRect().top)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const rect = node.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight * 1.2) continue;

      bubbles.push({ node, text, rect });
    }

    // Keep reading order top → bottom.
    bubbles.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    return bubbles.slice(-120);
  }

  function roleForBubble(bubble, midpoint) {
    const aria = clean(
      bubble.node.closest("[aria-label]")?.getAttribute("aria-label") ||
        bubble.node.getAttribute("aria-label") ||
        "",
    );
    if (/you sent|sent by you|outgoing/i.test(aria)) return "you";
    if (/said:|incoming|received/i.test(aria)) return "buyer";

    const centerX = bubble.rect.left + bubble.rect.width / 2;
    // Right half ≈ your outbound bubbles on Messenger/Marketplace.
    if (centerX >= midpoint + 40) return "you";
    if (centerX <= midpoint - 40) return "buyer";
    // Centered short notices.
    if (bubble.text.length < 80 && bubble.rect.width < window.innerWidth * 0.45) return "system";
    return centerX >= midpoint ? "you" : "buyer";
  }

  function scrapeThread() {
    const bubbles = collectBubbleCandidates();
    const midpoint = window.innerWidth / 2;
    const messages = [];
    for (const bubble of bubbles) {
      const role = roleForBubble(bubble, midpoint);
      const text = bubble.text;
      if (!text) continue;
      const prev = messages[messages.length - 1];
      if (prev && prev.role === role && prev.text === text) continue;
      messages.push({ role, text });
    }

    return {
      ok: true,
      page: "thread",
      counterpartName: counterpartFromPage(),
      threadUrl: location.href,
      threadKey: threadKeyFromUrl(location.href),
      messages,
      labeledTranscript: messages.map((m) => `[${m.role}] ${m.text}`).join("\n"),
    };
  }

  function scrapeInbox() {
    const rows = [];
    const anchors = Array.from(document.querySelectorAll("a[href*='/marketplace/t/'], a[href*='/messages/t/']"));
    const seen = new Set();
    for (const anchor of anchors.slice(0, 60)) {
      const href = anchor.href || "";
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const text = clean(anchor.textContent).slice(0, 220);
      if (!text) continue;
      const parts = text.split(/(?<=\w)\s{2,}|\n/).map(clean).filter(Boolean);
      const counterpartName = (parts[0] || "").slice(0, 80);
      const preview = (parts.slice(1).join(" ") || text).slice(0, 160);
      rows.push({
        threadKey: threadKeyFromUrl(href) || `inbox:${counterpartName.toLowerCase().replace(/\s+/g, "-")}`,
        counterpartName,
        preview,
        threadUrl: href,
        waitingOn: /unread|replied|waiting/i.test(text) ? "you" : "you",
      });
    }
    return { ok: true, page: "inbox", items: rows };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message?.type === "PRINT_OPS_PING") {
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === "PRINT_OPS_SCRAPE_THREAD") {
        sendResponse(scrapeThread());
        return;
      }
      if (message?.type === "PRINT_OPS_SCRAPE_INBOX") {
        sendResponse(scrapeInbox());
        return;
      }
      sendResponse({ ok: false, error: "Unknown message" });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Scrape failed" });
    }
    return true;
  });
})();
