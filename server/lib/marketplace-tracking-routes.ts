import type { Express, Request, Response } from "express";
import { z } from "zod";
import { getFulfillmentChecklist } from "./fulfillment";
import { hubspotRequest } from "./hubspot";

const pushSchema = z.object({
  dealId: z.string().trim().regex(/^[0-9]{1,20}$/),
  marketplace: z.enum(["ebay", "etsy"]),
});

export type MarketplacePushMode = "dry-run" | "live";

export function marketplacePushMode(marketplace: "ebay" | "etsy", env: NodeJS.ProcessEnv = process.env): MarketplacePushMode {
  const key = marketplace === "ebay" ? "MARKETPLACE_EBAY_TRACKING_PUSH_MODE" : "MARKETPLACE_ETSY_TRACKING_PUSH_MODE";
  return String(env[key] ?? "").trim().toLowerCase() === "live" ? "live" : "dry-run";
}

async function writeTrackingPushNote(dealId: string, marketplace: "ebay" | "etsy", trackingNumber: string, mode: MarketplacePushMode) {
  const body = `<p>Print Ops tracking push requested by owner.</p><ul><li>Marketplace: ${marketplace}</li><li>Tracking: ${trackingNumber}</li><li>Mode: ${mode}</li></ul>`;
  const note = await hubspotRequest("/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({ properties: { hs_note_body: body, hs_timestamp: new Date().toISOString() } }),
  });
  if (note?.id) {
    await hubspotRequest(`/crm/v4/objects/notes/${encodeURIComponent(String(note.id))}/associations/default/deals/${encodeURIComponent(dealId)}`, { method: "PUT" });
  }
}

export function registerMarketplaceTrackingRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean): void {
  app.post("/api/marketplace-tracking/push", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = pushSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Select a valid order and marketplace." });
    const checklist = getFulfillmentChecklist(parsed.data.dealId);
    const trackingNumber = checklist.trackingNumber.trim();
    if (!trackingNumber) return res.status(409).json({ ok: false, error: "Add tracking before pushing it to a marketplace." });
    const mode = marketplacePushMode(parsed.data.marketplace);
    try {
      await writeTrackingPushNote(parsed.data.dealId, parsed.data.marketplace, trackingNumber, mode);
      return res.json({ ok: true, mode, trackingNumber, pushed: false, message: mode === "live" ? "Marketplace adapter is not configured; HubSpot note recorded." : "Dry run recorded in HubSpot; no marketplace request was sent." });
    } catch (error) {
      return res.status(502).json({ ok: false, error: error instanceof Error ? error.message : "Could not record tracking push." });
    }
  });
}
