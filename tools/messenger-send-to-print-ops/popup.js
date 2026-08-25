const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text || "";
}

async function run(type) {
  setStatus(type === "inbox" ? "Scanning inbox…" : "Scanning thread…");
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) {
    setStatus(response?.error || "Failed");
    return;
  }
  setStatus("Opening Print Ops…");
  window.close();
}

document.getElementById("inbox").addEventListener("click", () => {
  run("print-ops-inbox-brief").catch((error) => setStatus(error?.message || String(error)));
});
document.getElementById("thread").addEventListener("click", () => {
  run("print-ops-scan-request").catch((error) => setStatus(error?.message || String(error)));
});
document.getElementById("options").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});
