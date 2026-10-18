import assert from "node:assert/strict";
import test from "node:test";
import {
  PHONE_DESCRIPTIONS,
  PHONE_MORE_HREF,
  phoneBackTarget,
  PC_ONLY_ROUTES,
  PHONE_LANDSCAPE_QUERY,
  PHONE_WIDTH_QUERY,
  isPhoneFrom,
  pcOnlyRouteFor,
  phoneMoreSections,
  phoneNavHrefs,
  phoneTabs,
} from "../client/src/lib/phone";

/** Fake matchMedia for a viewport + pointer. */
function media({ width, height, coarse }: { width: number; height: number; coarse: boolean }) {
  return (query: string) => {
    if (query === PHONE_WIDTH_QUERY) return width <= 767;
    if (query === PHONE_LANDSCAPE_QUERY) return coarse && width <= 932 && height <= 500;
    throw new Error(`unexpected query ${query}`);
  };
}

test("isPhoneFrom: phones portrait and sideways are phones; desktop and tablets are not", () => {
  assert.equal(isPhoneFrom(media({ width: 390, height: 844, coarse: true })), true);
  assert.equal(isPhoneFrom(media({ width: 430, height: 932, coarse: true })), true);
  assert.equal(isPhoneFrom(media({ width: 844, height: 390, coarse: true })), true, "phone held sideways");
  assert.equal(isPhoneFrom(media({ width: 1440, height: 1000, coarse: false })), false, "desktop unchanged");
  assert.equal(isPhoneFrom(media({ width: 1024, height: 768, coarse: true })), false, "tablet landscape keeps PC tools");
  assert.equal(isPhoneFrom(media({ width: 900, height: 480, coarse: false })), false, "short desktop window with a mouse");
  assert.equal(isPhoneFrom(media({ width: 700, height: 900, coarse: false })), true, "narrow window uses the phone layout");
});

test("isPhoneFrom: a matchMedia that throws counts as not a phone", () => {
  assert.equal(isPhoneFrom(() => { throw new Error("no matchMedia"); }), false);
});

const NAV = [
  "/", "/stack", "/queue", "/prints", "/library", "/labels", "/shipments", "/inbox", "/orders", "/quote",
  "/paid-orders", "/printers", "/supplies", "/expenses", "/deals", "/operations", "/performance", "/setup", "/nerve",
].map((href) => ({ href, label: href }));

test("phone tabs are Work hub, Inbox, Printers, Print queue in that order", () => {
  assert.deepEqual(phoneTabs(NAV).map((i) => i.href), ["/", "/inbox", "/printers", "/queue"]);
});

test("phone More is grouped and never lists PC-only pages or tab pages", () => {
  const sections = phoneMoreSections(NAV);
  assert.deepEqual(sections.map((s) => s.title), ["Orders", "Make", "Shop"]);
  assert.deepEqual(sections.map((s) => s.items.map((i) => i.href)), [
    ["/stack", "/orders", "/paid-orders", "/shipments", "/labels"],
    ["/quote", "/prints"],
    ["/supplies", "/expenses", "/performance", "/nerve"],
  ]);
  const reachable = phoneNavHrefs(NAV);
  for (const href of Object.keys(PC_ONLY_ROUTES)) assert.equal(reachable.includes(href), false, `${href} is in phone nav`);
  assert.equal(new Set(reachable).size, reachable.length, "no duplicates");
});

test("phone More picks up Files once the desktop NAV has it; Nerve hides when its flag is off", () => {
  const withFiles = phoneMoreSections([...NAV, { href: "/files", label: "Files" }]);
  assert.deepEqual(withFiles.find((s) => s.title === "Make")?.items.map((i) => i.href), ["/quote", "/files", "/prints"]);
  const noNerve = phoneMoreSections(NAV.filter((i) => i.href !== "/nerve"));
  assert.deepEqual(noNerve.find((s) => s.title === "Shop")?.items.map((i) => i.href), ["/supplies", "/expenses", "/performance"]);
});

test("every desktop page is either in the phone nav or a PC-only page", () => {
  const reachable = new Set(phoneNavHrefs(NAV));
  const missing = NAV.map((i) => i.href).filter((href) => !reachable.has(href) && !pcOnlyRouteFor(href));
  assert.deepEqual(missing, []);
});

test("pcOnlyRouteFor ignores query strings and trailing slashes; phone pages are not gated", () => {
  assert.equal(pcOnlyRouteFor("/setup?tab=hubspot")?.what, PC_ONLY_ROUTES["/setup"]!.what);
  assert.ok(pcOnlyRouteFor("/library/"));
  for (const href of ["/", "/inbox", "/printers", "/queue", "/quote", "/prints", "/stack", "/labels", "/nerve"]) {
    assert.equal(pcOnlyRouteFor(href), null, href);
  }
  for (const route of Object.values(PC_ONLY_ROUTES)) {
    if (route.alt) assert.equal(pcOnlyRouteFor(route.alt.href), null, `alt ${route.alt.href} must work on a phone`);
  }
});

test("phone More page: every More row has a one-line description and Back goes to #/more", () => {
  const nav = [...NAV, { href: "/files", label: "Files" }, { href: "/nerve", label: "Nerve" }];
  for (const item of phoneMoreSections(nav).flatMap((s) => s.items)) {
    const desc = PHONE_DESCRIPTIONS[item.href];
    assert.ok(desc && desc.length <= 40, `More row ${item.href} needs a short description`);
  }
  assert.equal(PHONE_MORE_HREF, "/more");
  const more = phoneMoreSections(nav).flatMap((s) => s.items).map((i) => i.href);
  assert.equal(phoneBackTarget("/labels", more), "/more");
  assert.equal(phoneBackTarget("/labels?tab=buy", more), "/more");
  assert.equal(phoneBackTarget("/inbox", more), null);
  assert.equal(phoneBackTarget("/", more), null);
});
