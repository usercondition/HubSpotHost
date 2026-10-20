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
  "/", "/inbox", "/prints", "/printers", "/labels", "/orders", "/quote", "/files", "/spending", "/setup",
].map((href) => ({ href, label: href }));

test("phone tabs are Hub, Inbox, Print files, Printers in that order", () => {
  assert.deepEqual(phoneTabs(NAV).map((i) => i.href), ["/", "/inbox", "/prints", "/printers"]);
});

test("phone More is grouped and never lists PC-only pages or tab pages", () => {
  const sections = phoneMoreSections(NAV);
  assert.deepEqual(sections.map((s) => s.title), ["Run", "Take", "Keep"]);
  assert.deepEqual(sections.map((s) => s.items.map((i) => i.href)), [
    ["/labels"],
    ["/orders", "/quote", "/files"],
    ["/spending", "/setup"],
  ]);
  const reachable = phoneNavHrefs(NAV);
  for (const href of Object.keys(PC_ONLY_ROUTES)) assert.equal(reachable.includes(href), false, `${href} is in phone nav`);
  assert.equal(new Set(reachable).size, reachable.length, "no duplicates");
});

test("phone More comes only from primary navigation", () => {
  const noFiles = phoneMoreSections(NAV.filter((i) => i.href !== "/files"));
  assert.deepEqual(noFiles.find((s) => s.title === "Take")?.items.map((i) => i.href), ["/orders", "/quote"]);
  const noSetup = phoneMoreSections(NAV.filter((i) => i.href !== "/setup"));
  assert.deepEqual(noSetup.find((s) => s.title === "Keep")?.items.map((i) => i.href), ["/spending"]);
});

test("every desktop page is either in the phone nav or a PC-only page", () => {
  const reachable = new Set(phoneNavHrefs(NAV));
  const missing = NAV.map((i) => i.href).filter((href) => !reachable.has(href) && !pcOnlyRouteFor(href));
  assert.deepEqual(missing, []);
});

test("pcOnlyRouteFor ignores query strings and trailing slashes; phone pages are not gated", () => {
  assert.equal(pcOnlyRouteFor("/deals?view=board")?.what, PC_ONLY_ROUTES["/deals"]!.what);
  assert.ok(pcOnlyRouteFor("/library/"));
  for (const href of ["/", "/inbox", "/printers", "/quote", "/prints", "/labels"]) {
    assert.equal(pcOnlyRouteFor(href), null, href);
  }
  for (const route of Object.values(PC_ONLY_ROUTES)) {
    if (route.alt) assert.equal(pcOnlyRouteFor(route.alt.href), null, `alt ${route.alt.href} must work on a phone`);
  }
});

test("phone More page: every More row has a one-line description and Back goes to #/more", () => {
  const nav = NAV;
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
