/**
 * Extension service worker:
 * - Inbox brief → secretary summary page
 * - Single thread → Manual bridge (legacy assist)
 */

const DEFAULTS = {
  baseUrl: "https://print-orders-margin.pplx.app/port/5000",
  accessCode: "",
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return {
    baseUrl: String(stored.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, ""),
    accessCode: String(stored.accessCode || ""),
  };
}

async function ensureContent(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch {
    // Already injected or restricted page.
  }
}

async function scrapeActiveTab(tabId) {
  await ensureContent(tabId);
  const response = await chrome.tabs.sendMessage(tabId, { type: "print-ops-scrape-thread" });
  if (!response?.ok) throw new Error(response?.error || "Scrape failed");
  return response;
}

async function scrapeInbox(tabId) {
  await ensureContent(tabId);
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "print-ops-scrape-inbox",
    maxThreads: 20,
  });
  if (!response?.ok) throw new Error(response?.error || "Inbox scrape failed");
  return response;
}

async function createBridge(settings, scrape) {
  if (!settings.accessCode) {
    throw new Error("Set your owner access code in the extension options first.");
  }
  const response = await fetch(`${settings.baseUrl}/api/paid-orders/messenger-bridge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paid-order-access-code": settings.accessCode,
    },
    body: JSON.stringify({
      conversation: scrape.conversation,
      title: scrape.title || "",
      source: "messenger-extension",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.ok || !body?.id) {
    throw new Error(body?.error || `Bridge failed (HTTP ${response.status})`);
  }
  return body.id;
}

async function createBrief(settings, inbox) {
  if (!settings.accessCode) {
    throw new Error("Set your owner access code in the extension options first.");
  }
  const response = await fetch(`${settings.baseUrl}/api/marketplace-brief`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paid-order-access-code": settings.accessCode,
    },
    body: JSON.stringify({ threads: inbox.threads || [] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.ok || !body?.id) {
    throw new Error(body?.error || `Brief failed (HTTP ${response.status})`);
  }
  return body;
}

async function getMarketplaceSendRequest(settings) {
  if (!settings.accessCode) {
    throw new Error("Set your owner access code in the extension options first.");
  }
  const response = await fetch(`${settings.baseUrl}/api/marketplace-send-request`, {
    headers: { "x-paid-order-access-code": settings.accessCode },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `Could not read shipment request (HTTP ${response.status})`);
  return body;
}

async function clearMarketplaceSendRequest(settings) {
  const response = await fetch(`${settings.baseUrl}/api/marketplace-send-request`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paid-order-access-code": settings.accessCode,
    },
    body: JSON.stringify({ pending: false }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.ok) throw new Error(body?.error || `Could not clear shipment request (HTTP ${response.status})`);
}

function appUrl(baseUrl, pathWithQuery) {
  // Hash router: /#/marketplace-brief?brief=…
  const [path, query] = pathWithQuery.split("?");
  const hash = query ? `#${path}?${query}` : `#${path}`;
  return `${baseUrl}/${hash}`;
}

async function runThreadScan(tab) {
  if (!tab?.id) throw new Error("No active tab");
  const settings = await getSettings();
  const scrape = await scrapeActiveTab(tab.id);
  const bridgeId = await createBridge(settings, scrape);
  const url = appUrl(settings.baseUrl, `/paid-orders?bridge=${encodeURIComponent(bridgeId)}`);
  await chrome.tabs.create({ url, active: true });
  return { bridgeId, bubbleCount: scrape.bubbleCount };
}

async function runInboxBrief(tab) {
  if (!tab?.id) throw new Error("No active Messenger / mock inbox tab");
  const settings = await getSettings();
  const inbox = await scrapeInbox(tab.id);
  const created = await createBrief(settings, inbox);
  const url = appUrl(settings.baseUrl, `/marketplace-brief?brief=${encodeURIComponent(created.id)}`);
  await chrome.tabs.create({ url, active: true });
  return {
    briefId: created.id,
    threadCount: inbox.threads?.length || 0,
    headline: created.brief?.headline || "",
  };
}

async function runQueuedShipment(tab) {
  if (!tab?.id) throw new Error("Open Marketplace Messenger or the mock inbox before sending.");
  const settings = await getSettings();
  const request = await getMarketplaceSendRequest(settings);
  if (!request.pending) return { pending: false };
  if (!request.to || !request.text) throw new Error("Queued shipment is missing a buyer or message; it was not sent.");
  await ensureContent(tab.id);
  const sent = await chrome.tabs.sendMessage(tab.id, {
    type: "print-ops-send-marketplace-request",
    to: request.to,
    text: request.text,
  });
  if (!sent?.ok) throw new Error(sent?.error || "Could not send shipment notice; request remains pending.");
  // Only acknowledge the server slot after the page reports a successful send.
  await clearMarketplaceSendRequest(settings);
  return { pending: true, to: request.to, title: sent.title };
}

function alertOnTab(tabId, message) {
  if (!tabId) return;
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (text) => window.alert(text),
      args: [message],
    })
    .catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  if (message.type === "print-ops-scan-request") {
    const tab = sender.tab;
    runThreadScan(tab)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        alertOnTab(tab?.id, error?.message || String(error));
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }
  if (message.type === "print-ops-inbox-brief") {
    // Popup may not include sender.tab — resolve active tab.
    const go = async () => {
      let tab = sender.tab;
      if (!tab?.id) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = active;
      }
      return runInboxBrief(tab);
    };
    go()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
          alertOnTab(active?.id, error?.message || String(error));
        });
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }
  if (message.type === "print-ops-send-queued-shipment") {
    const go = async () => {
      let tab = sender.tab;
      if (!tab?.id) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = active;
      }
      return runQueuedShipment(tab);
    };
    go()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
          alertOnTab(active?.id, error?.message || String(error));
        });
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }
});
