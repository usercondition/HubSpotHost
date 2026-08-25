const DEFAULTS = {
  baseUrl: "http://127.0.0.1:5000",
  accessCode: "",
};

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById("baseUrl").value = stored.baseUrl || DEFAULTS.baseUrl;
  document.getElementById("accessCode").value = stored.accessCode || "";
}

async function save() {
  const baseUrl = document.getElementById("baseUrl").value.trim().replace(/\/$/, "");
  const accessCode = document.getElementById("accessCode").value.trim();
  if (!baseUrl) throw new Error("Base URL is required");

  // Request host access for whatever Print Ops URL you configured (local or Railway).
  try {
    const origin = new URL(baseUrl).origin + "/*";
    await chrome.permissions.request({ origins: [origin] });
  } catch {
    // older / restricted environments — host_permissions may already cover localhost
  }

  await chrome.storage.sync.set({ baseUrl, accessCode });
  document.getElementById("status").textContent = "Saved.";
}

document.getElementById("save").addEventListener("click", () => {
  save().catch((error) => {
    document.getElementById("status").textContent = error?.message || String(error);
  });
});

load();
