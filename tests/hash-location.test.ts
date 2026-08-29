import test from "node:test";
import assert from "node:assert/strict";

/**
 * Minimal window/location mock for hash-router helpers (node:test has no DOM).
 */
function installHashWindow(initialHash = "#/", initialSearch = "") {
  const location: {
    pathname: string;
    search: string;
    hash: string;
  } = {
    pathname: "/app",
    search: initialSearch,
    hash: initialHash,
  };

  const history = {
    replaceState(_state: unknown, _title: string, url: string) {
      const parsed = new URL(url, "https://printops.test");
      location.pathname = parsed.pathname;
      location.search = parsed.search;
      location.hash = parsed.hash;
    },
  };

  (globalThis as { window?: unknown }).window = {
    location,
    history,
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as { location?: unknown }).location = location;

  return location;
}

test("hash navigate keeps query string inside the hash", async () => {
  const location = installHashWindow("#/", "");
  const { navigateHash, currentHashPath } = await import("../client/src/lib/hash-location");
  const { readHashQueryParam } = await import("../client/src/lib/workflow");

  navigateHash("/focus?kind=costs");
  assert.equal(location.hash, "#/focus?kind=costs");
  assert.equal(currentHashPath(), "/focus?kind=costs");
  assert.equal(readHashQueryParam("kind"), "costs");
  assert.equal(location.search, "");

  navigateHash("/prints?dealId=99");
  assert.equal(location.hash, "#/prints?dealId=99");
  assert.equal(readHashQueryParam("dealId"), "99");
});

test("readHashQueryParam still accepts legacy location.search parking", async () => {
  installHashWindow("#/focus", "?kind=stale");
  const { readHashQueryParam } = await import("../client/src/lib/workflow");
  assert.equal(readHashQueryParam("kind"), "stale");
});
