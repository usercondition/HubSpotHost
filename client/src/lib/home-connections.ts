export type ConnectionTone = "good" | "warn" | "bad" | "paused" | "unknown";

export type HomeConnection = {
  id: string;
  label: string;
  tone: ConnectionTone;
  detail: string;
  href: string;
};

type Heartbeat = {
  service: string;
  status: "green" | "yellow" | "red";
  metrics: Record<string, unknown>;
  timestamp: string;
};

function toneFromStatus(status: Heartbeat["status"]): ConnectionTone {
  if (status === "green") return "good";
  if (status === "yellow") return "warn";
  return "bad";
}

function findHeartbeat(heartbeats: Heartbeat[], names: string[]): Heartbeat | undefined {
  const lower = names.map((n) => n.toLowerCase());
  return heartbeats.find((h) => lower.includes(h.service.toLowerCase()));
}

export function buildHomeConnections(input: {
  heartbeats: Heartbeat[];
  pending: boolean;
  offerUpPaused: boolean;
  paperclipHref: string;
  hubspotHref: string;
  railwayHref: string;
}): HomeConnection[] {
  const hb = input.heartbeats;
  const syncthing = findHeartbeat(hb, ["Syncthing"]);
  const make = findHeartbeat(hb, ["Make"]);
  const paperclip = findHeartbeat(hb, ["Paperclip"]);
  const railway = findHeartbeat(hb, ["Railway", "Hub"]);
  const hubspot = findHeartbeat(hb, ["HubSpot"]);

  const fallbackTone = (hit: Heartbeat | undefined): ConnectionTone =>
    hit ? toneFromStatus(hit.status) : input.pending ? "unknown" : "unknown";

  return [
    { id: "ebay", label: "eBay", tone: "unknown", detail: "listings", href: "/marketplace-brief" },
    { id: "etsy", label: "Etsy", tone: "unknown", detail: "listings", href: "/marketplace-brief" },
    {
      id: "offerup",
      label: "OfferUp",
      tone: input.offerUpPaused ? "paused" : "unknown",
      detail: input.offerUpPaused ? "paused" : "listings",
      href: "/marketplace-brief",
    },
    {
      id: "hubspot",
      label: "HubSpot",
      tone: fallbackTone(hubspot),
      detail: hubspot ? hubspot.status : input.pending ? "pending" : "open",
      href: input.hubspotHref,
    },
    {
      id: "paperclip",
      label: "Paperclip",
      tone: fallbackTone(paperclip),
      detail: paperclip ? paperclip.status : "agents",
      href: input.paperclipHref,
    },
    {
      id: "syncthing",
      label: "Syncthing",
      tone: fallbackTone(syncthing),
      detail: syncthing ? String(syncthing.metrics.peers ?? syncthing.status) : input.pending ? "pending" : "—",
      href: "/setup",
    },
    {
      id: "make",
      label: "Make",
      tone: fallbackTone(make),
      detail: make ? make.status : input.pending ? "pending" : "—",
      href: "/setup",
    },
    {
      id: "railway",
      label: "Railway",
      tone: fallbackTone(railway),
      detail: railway ? railway.status : "Hub",
      href: input.railwayHref,
    },
  ];
}
