import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stackDrawerDealId } from "../client/src/lib/deal-link";
import { readHashQueryParam, takeDealIdFromLocation } from "../client/src/lib/workflow";
import { navigateHash } from "../client/src/lib/hash-location";

const CLOSED_DEAL = "340206100176";

/**
 * Minimal window/location mock for hash-router helpers (node:test has no DOM).
 */
function installHashWindow(initialHash = "#/", initialSearch = "") {
  const location: {
    pathname: string;
    search: string;
    hash: string;
  } = {
    pathname: "/",
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

const onStack = {
  rows: [
    { dealId: "111", members: [] },
    { dealId: null, members: [{ dealId: "222" }] },
  ],
  outTheDoor: [{ dealId: "333" }],
};

test("loading /?dealId=<closed id>#/stack opens no drawer and leaves a clean URL", () => {
  const location = installHashWindow("#/stack", `?dealId=${CLOSED_DEAL}`);

  const linked = takeDealIdFromLocation();
  const drawer = stackDrawerDealId(linked, onStack);
  assert.equal(linked, CLOSED_DEAL);
  assert.equal(drawer, null);
  assert.equal(location.search, "");
  assert.equal(location.hash, "#/stack");
  assert.equal(`${location.pathname}${location.search}${location.hash}`, "/#/stack");
  assert.equal(readHashQueryParam("dealId"), null);

  navigateHash("/stack");
  const again = takeDealIdFromLocation();
  assert.equal(again, null);
  assert.equal(stackDrawerDealId(again, onStack), null);
  assert.equal(location.search, "");
  assert.equal(location.hash, "#/stack");
  assert.equal(readHashQueryParam("dealId"), null);
});

test("a Stack tab click drops a stale pre-hash dealId and does not restore it", () => {
  const location = installHashWindow("#/", `?dealId=${CLOSED_DEAL}`);
  navigateHash("/stack");
  assert.equal(location.search, "");
  assert.equal(location.hash, "#/stack");
  assert.equal(readHashQueryParam("dealId"), null);
  assert.equal(stackDrawerDealId(takeDealIdFromLocation(), onStack), null);

  navigateHash("/queue");
  navigateHash("/stack");
  assert.equal(`${location.pathname}${location.search}${location.hash}`, "/#/stack");
  assert.equal(readHashQueryParam("dealId"), null);
});

test("a deal that is on the Stack still opens, then the link is stripped from search and hash", () => {
  const location = installHashWindow("#/stack?dealId=222", "?dealId=999&tab=run");
  const linked = takeDealIdFromLocation();
  assert.equal(stackDrawerDealId(linked, onStack), "222");
  assert.equal(location.search, "?tab=run");
  assert.equal(location.hash, "#/stack");
  assert.equal(readHashQueryParam("dealId"), null);
  assert.equal(stackDrawerDealId("333", onStack), "333");
  assert.equal(stackDrawerDealId("999", onStack), null);
});

test("Queue strips dealId from the pre-hash search and the hash after reading the link", () => {
  const location = installHashWindow(`#/queue?dealId=${CLOSED_DEAL}`, `?dealId=${CLOSED_DEAL}`);
  assert.equal(takeDealIdFromLocation(), CLOSED_DEAL);
  assert.equal(location.search, "");
  assert.equal(location.hash, "#/queue");
  navigateHash("/queue");
  assert.equal(readHashQueryParam("dealId"), null);
  assert.equal(`${location.pathname}${location.search}${location.hash}`, "/#/queue");
});

test("Stack and Queue pages do not open a deal id straight from the URL", () => {
  const stack = readFileSync(new URL("../client/src/pages/priority-stack.tsx", import.meta.url), "utf8");
  const queue = readFileSync(new URL("../client/src/pages/queue.tsx", import.meta.url), "utf8");
  assert.match(stack, /stackDrawerDealId/);
  assert.match(stack, /stripDealIdFromLocation/);
  assert.match(queue, /stripDealIdFromLocation/);
  assert.doesNotMatch(stack, /useState<string \| null>\(\(\) => readHashQueryParam\("dealId"\)\)/);
  assert.doesNotMatch(queue, /useState<string \| null>\(\(\) => readHashQueryParam\("dealId"\)\)/);
});
