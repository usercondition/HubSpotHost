import test from "node:test";
import assert from "node:assert/strict";
import { attachmentLabel, buildChatItems, listTime, splitLinks, visibleThreads } from "../client/src/lib/nerve-chat";

test("visibleThreads hides archived, deleted and soft-deleted threads", () => {
  const rows = [
    { uid: "a", name: "A", sortAt: "2026-10-17T21:37:00Z", deleted: true, softDeleted: true },
    { uid: "b", name: "B", sortAt: "2026-10-17T21:32:00Z" },
    { uid: "c", name: "C", sortAt: "2026-10-17T21:30:00Z", archived: true },
    { uid: "d", name: "D", sortAt: "2026-10-01T00:00:00Z", softDeleted: true },
  ];
  assert.deepEqual(visibleThreads(rows).map((t) => t.uid), ["b"]);
});

test("visibleThreads sorts by the real latest message time, newest first, even if the server order is stale", () => {
  const rows = [
    { uid: "noon-label", name: "X", sortAt: "2026-10-16T19:00:00Z" },
    { uid: "late", name: "Y", sortAt: "2026-10-17T03:33:00Z" },
    { uid: "newest", name: "Z", sortAt: "2026-10-17T21:32:00Z" },
    { uid: "no-time", name: "N" },
  ];
  assert.deepEqual(visibleThreads(rows).map((t) => t.uid), ["newest", "late", "noon-label", "no-time"]);
});

test("splitLinks turns raw URLs into domain chips", () => {
  const p = splitLinks("see https://www.facebook.com/marketplace/item/123456789012345/?ref=abc, thanks");
  assert.equal(p.length, 3);
  assert.deepEqual(p[1], { kind: "link", href: "https://www.facebook.com/marketplace/item/123456789012345/?ref=abc", domain: "facebook.com" });
  assert.equal(p[2].kind === "text" && p[2].text, ", thanks");
});

test("buildChatItems drops blank bubbles, keeps attachments, groups same sender and adds dividers", () => {
  const t0 = Date.parse("2026-10-16T20:00:00-07:00");
  const items = buildChatItems(
    [
      { who: "buyer", text: "hi", at: t0 },
      { who: "buyer", text: "", at: t0 + 60_000 },
      { who: "buyer", text: "", at: t0 + 60_000, attachments: [{ kind: "attachment", label: "Attachment" }] },
      { who: "me", text: "hello", at: t0 + 120_000 },
      { who: "me", text: "later", at: t0 + 3 * 3_600_000 },
    ],
    new Date("2026-10-17T15:00:00-07:00"),
  );
  const kinds = items.map((i) => (i.kind === "divider" ? "D" : i.mine ? "M" : "B"));
  assert.deepEqual(kinds, ["D", "B", "B", "M", "D", "M"]);
  const b = items.filter((i) => i.kind === "bubble");
  assert.deepEqual(b.map((i) => (i.kind === "bubble" ? [i.first, i.last] : null)), [[true, false], [false, true], [true, true], [true, true]]);
  assert.equal(items[0].kind === "divider" && items[0].label, "Yesterday 8:00 PM");
  assert.equal(attachmentLabel({ kind: "attachment", label: "Attachment" }), "Photo");
});

test("listTime: today time, yesterday, weekday, date", () => {
  const now = new Date("2026-10-17T15:40:00-07:00");
  assert.equal(listTime("2026-10-17T21:37:00Z", now), "2:37 PM");
  assert.equal(listTime("2026-10-17T03:33:00Z", now), "Yesterday");
  assert.equal(listTime("2026-10-14T02:38:00Z", now), "Tue");
  assert.equal(listTime("2026-10-08T02:07:00Z", now), "Oct 7");
});
