/**
 * Extension service worker: scrape active tab → bridge API → open Manual entry.
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

async function scrapeActiveTab(tabId) {
  // Ensure content script is present (SPA navigations / mock page).
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch {
    // Already injected or restricted page.
  }

  const response = await chrome.tabs.sendMessage(tabId, { type: "print-ops-scrape-thread" });
  if (!response?.ok) {
    throw new Error(response?.error || "Scrape failed");
  }
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

async function runScan(tab) {
  if (!tab?.id) throw new Error("No active tab");
  const settings = await getSettings();
  const scrape = await scrapeActiveTab(tab.id);
  const bridgeId = await createBridge(settings, scrape);
  const url = `${settings.baseUrl}/paid-orders?bridge=${encodeURIComponent(bridgeId)}`;
  await chrome.tabs.create({ url, active: true });
  return { bridgeId, bubbleCount: scrape.bubbleCount };
}

chrome.action.onClicked.addListener((tab) => {
  runScan(tab).catch((error) => {
    console.error(error);
    chrome.notifications?.create?.({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Print Ops Messenger scan",
      message: error?.message || String(error),
    });
    // Fallback when notifications permission is missing.
    if (tab?.id) {
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          func: (message) => window.alert(message),
          args: [error?.message || String(error)],
        })
        .catch(() => undefined);
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "print-ops-scan-request") return;
  const tab = sender.tab;
  runScan(tab)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
