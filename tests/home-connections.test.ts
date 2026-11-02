import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHomeConnections, homeSectionOrder } from "../client/src/lib/home-connections";

describe("buildHomeConnections", () => {
  it("maps Syncthing heartbeat and marks OfferUp paused", () => {
    const tiles = buildHomeConnections({
      heartbeats: [
        { service: "Syncthing", status: "green", metrics: { peers: 2 }, timestamp: "2026-11-02T00:00:00Z" },
      ],
      pending: false,
      offerUpPaused: true,
      paperclipHref: "https://miguels-mac-mini.tailc0d52c.ts.net/",
      hubspotHref: "https://app-na2.hubspot.com/contacts/246947621/objects/0-3/views/all/board",
      railwayHref: "https://hubspothost-production.up.railway.app/",
    });
    const syncthing = tiles.find((t) => t.id === "syncthing");
    const offerup = tiles.find((t) => t.id === "offerup");
    assert.equal(syncthing?.tone, "good");
    assert.equal(offerup?.tone, "paused");
    assert.ok(tiles.some((t) => t.id === "ebay"));
    assert.ok(tiles.some((t) => t.id === "paperclip"));
  });

  it("uses unknown when systems feed is pending", () => {
    const tiles = buildHomeConnections({
      heartbeats: [],
      pending: true,
      offerUpPaused: false,
      paperclipHref: "https://example.com/paperclip",
      hubspotHref: "https://example.com/hubspot",
      railwayHref: "https://example.com/railway",
    });
    const make = tiles.find((t) => t.id === "make");
    assert.equal(make?.tone, "unknown");
  });
});

describe("homeSectionOrder", () => {
  it("locks Home section order", () => {
    assert.deepEqual(homeSectionOrder(), ["needs", "production", "connections"]);
  });
});
