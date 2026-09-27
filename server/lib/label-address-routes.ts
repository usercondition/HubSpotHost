import type { Express, Request, Response } from "express";
import { HubSpotError, HUBSPOT_BUSY_MESSAGE, isHubSpotBusyError } from "./hubspot";
import { applyAddressCleanup, listAddressAudit, verifyAddressNow } from "./label-address";

function hubspotFailure(error: unknown, fallback: string): { status: number; error: string } {
  if (isHubSpotBusyError(error)) return { status: 503, error: HUBSPOT_BUSY_MESSAGE };
  const status = error instanceof HubSpotError ? error.status : 502;
  return {
    status,
    error: error instanceof Error ? error.message : fallback,
  };
}

export function registerLabelAddressRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean) {
  app.post("/api/shipping-labels/address-verify", async (req, res) => {
    if (rejectOwner(req, res)) return;
    const dealId = String((req.body as { dealId?: unknown } | null)?.dealId ?? "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    }
    try {
      const result = await verifyAddressNow(dealId);
      if (!result.ok) return res.status(result.status).json(result.body);
      return res.json(result.body);
    } catch (error) {
      const failure = hubspotFailure(error, "Could not verify the address");
      return res.status(failure.status).json({ ok: false, error: failure.error });
    }
  });

  app.post("/api/shipping-labels/address-cleanup", async (req, res) => {
    if (rejectOwner(req, res)) return;
    const dealId = String((req.body as { dealId?: unknown } | null)?.dealId ?? "").trim();
    const confirm = (req.body as { confirm?: unknown } | null)?.confirm;
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    }
    try {
      const result = await applyAddressCleanup({ dealId, confirm: confirm === true });
      if (!result.ok) return res.status(result.status).json(result.body);
      return res.json(result.body);
    } catch (error) {
      const failure = hubspotFailure(error, "Could not clean up the HubSpot address");
      return res.status(failure.status).json({ ok: false, error: failure.error });
    }
  });

  app.get("/api/shipping-labels/address-audit", async (req, res) => {
    if (rejectOwner(req, res)) return;
    try {
      const rows = await listAddressAudit();
      return res.json({ ok: true, rows });
    } catch (error) {
      const failure = hubspotFailure(error, "Could not audit addresses");
      return res.status(failure.status).json({ ok: false, error: failure.error });
    }
  });
}
