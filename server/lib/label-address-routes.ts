/**
 * Address and label HTTP. Validation and delegation only.
 */
import type { Express, Request, Response } from "express";
import {
  CLIENT_ADDRESS_ACK_FORM,
  CLIENT_ADDRESS_ACK_VERSION,
  buildAddressAckSnapshot,
  publicAddressFieldsSchema,
} from "../../shared/address-capture";
import { clientOrderSubmissionSchema } from "../../shared/schema";
import {
  addressEntryLabelFor,
  applyAddressCleanup,
  applyCapturedAddress,
  capturePayload,
  checkCapturedAddress,
  loadLabelShipTo,
  prepareClientAddressSubmit,
  previewPastedAddress,
  purchaseGatedLabel,
  quoteGatedLabelRates,
  verifyAddressNow,
} from "./address-capture";
import { PublicAddressRateLimitError } from "./address-checks";
import { consumeClientAttempt } from "./client-rate-limit";
import { HUBSPOT_BUSY_MESSAGE, isHubSpotBusyError } from "./hubspot";
import { lookupClientOrder, submitClientOrder } from "./order-links";
import { suggestAddresses } from "./address-suggest";
import {
  shipEnginePurchaseRequestSchema,
  shipEngineRatesRequestSchema,
} from "./shipengine";
import { firstIssue } from "./validation";

const ORDER_KEY = /^(deal|offbook):[0-9]{1,20}$/;
const DEAL_ID = /^[0-9]{1,20}$/;

function tokenFromBody(body: unknown): string {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const token = typeof record.token === "string" ? record.token.trim() : "";
  return /^[A-Za-z0-9_-]{16,200}$/.test(token) ? token : "";
}

function recordBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function text(row: Record<string, unknown>, key: string): string {
  return typeof row[key] === "string" ? row[key] : "";
}

function tooManyClientAttempts(req: Request, res: Response): boolean {
  if (!consumeClientAttempt(req.ip || "unknown")) return false;
  res.status(429).json({ ok: false, reason: "throttled" });
  return true;
}

function send(res: Response, result: { status: number; body: Record<string, unknown> }) {
  return res.status(result.status).json(result.body);
}

export function registerLabelAddressRoutes(
  app: Express,
  rejectOwner: (req: Request, res: Response) => boolean,
) {
  app.get("/api/address-entry", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const orderKey = typeof req.query.orderKey === "string" ? req.query.orderKey : "";
    if (!ORDER_KEY.test(orderKey)) return res.status(400).json({ ok: false, error: "Unknown order." });
    return res.json({ ok: true, addressEntryLabel: addressEntryLabelFor(orderKey) });
  });

  app.get("/api/shipping-labels/ship-to/:dealId", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    if (!DEAL_ID.test(dealId)) return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    return send(res, await loadLabelShipTo(dealId));
  });

  app.post("/api/shipping-labels/shipengine/rates", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = shipEngineRatesRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    return send(res, await quoteGatedLabelRates(parsed.data));
  });

  app.post("/api/shipping-labels/shipengine/purchase", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = shipEnginePurchaseRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    return send(res, await purchaseGatedLabel(parsed.data));
  });

  app.post("/api/shipping-labels/address-verify", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const dealId = text(recordBody(req.body), "dealId").trim();
    if (!DEAL_ID.test(dealId)) return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    try {
      const result = await verifyAddressNow(dealId);
      return send(res, result.ok ? { status: 200, body: result.body } : result);
    } catch (error) {
      if (isHubSpotBusyError(error)) return res.status(503).json({ ok: false, error: HUBSPOT_BUSY_MESSAGE });
      return send(res, { status: 502, body: { ok: false, error: error instanceof Error ? error.message : "Could not verify the address" } });
    }
  });

  app.post("/api/shipping-labels/address-cleanup", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const body = recordBody(req.body);
    const dealId = text(body, "dealId").trim();
    if (!DEAL_ID.test(dealId)) return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    try {
      const result = await applyAddressCleanup({ dealId, confirm: body.confirm === true });
      return send(res, result.ok ? { status: 200, body: result.body } : result);
    } catch (error) {
      if (isHubSpotBusyError(error)) return res.status(503).json({ ok: false, error: HUBSPOT_BUSY_MESSAGE });
      return send(res, { status: 502, body: { ok: false, error: error instanceof Error ? error.message : "Could not clean up the HubSpot address" } });
    }
  });

  app.post("/api/address-suggest", async (req: Request, res: Response) => {
    if (tooManyClientAttempts(req, res)) return;
    const query = text(recordBody(req.body), "query");
    try {
      return res.json({ ok: true, suggestions: await suggestAddresses(query) });
    } catch {
      return res.json({ ok: true, suggestions: [] });
    }
  });

  app.post("/api/client-order/validate-address", async (req: Request, res: Response) => {
    if (tooManyClientAttempts(req, res)) return;
    const token = tokenFromBody(req.body);
    if (!token) return res.status(404).json({ ok: false, reason: "invalid" });
    const lookup = lookupClientOrder(token);
    if (!lookup.ok) return res.status(lookup.reason === "invalid" ? 404 : 410).json(lookup);
    const parsed = publicAddressFieldsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, reason: "invalid-details", error: firstIssue(parsed.error) });
    try {
      const check = await checkCapturedAddress(
        {
          street1: parsed.data.shippingStreet,
          street2: parsed.data.shippingStreet2,
          city: parsed.data.shippingCity,
          state: parsed.data.shippingState,
          zip: parsed.data.shippingPostalCode,
          country: parsed.data.shippingCountry,
        },
        { audience: "public", rateKey: req.ip || "unknown" },
      );
      return res.json(capturePayload(check));
    } catch (error) {
      if (error instanceof PublicAddressRateLimitError) return res.status(429).json({ ok: false, reason: "throttled" });
      throw error;
    }
  });

  app.post("/api/client-order/submit", async (req: Request, res: Response) => {
    if (tooManyClientAttempts(req, res)) return;
    const token = tokenFromBody(req.body);
    if (!token) return res.status(404).json({ ok: false, reason: "invalid" });
    const parsed = clientOrderSubmissionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, reason: "invalid-details", error: firstIssue(parsed.error) });
    const body = recordBody(req.body);
    let submission = parsed.data;
    let intakeCheck: { status: string; checkedAt: string; choice: string; messages: string[] } | undefined;
    if (submission.shippingRequired) {
      let prepared: Awaited<ReturnType<typeof prepareClientAddressSubmit>>;
      try {
        prepared = await prepareClientAddressSubmit({
          fields: {
            street1: submission.shippingStreet,
            street2: submission.shippingStreet2,
            city: submission.shippingCity,
            state: submission.shippingState,
            zip: submission.shippingPostalCode,
            country: submission.shippingCountry,
          },
          decision: text(body, "addressDecision"),
          noUnit: body.noUnit === true,
          addressCheckToken: text(body, "addressCheckToken"),
          addressAcknowledged: body.addressAcknowledged === true,
          rateKey: req.ip || "unknown",
        });
      } catch (error) {
        if (error instanceof PublicAddressRateLimitError) return res.status(429).json({ ok: false, reason: "throttled" });
        throw error;
      }
      if (!prepared.ok) return res.status(prepared.status).json(prepared.body);
      submission = {
        ...submission,
        shippingStreet: prepared.fields.street1,
        shippingStreet2: prepared.fields.street2,
        shippingCity: prepared.fields.city,
        shippingState: prepared.fields.state,
        shippingPostalCode: prepared.fields.zip,
        shippingCountry: prepared.fields.country,
      };
      intakeCheck = {
        status: prepared.storedStatus,
        checkedAt: prepared.checkedAt,
        choice: prepared.choice,
        messages: prepared.messages,
      };
    }
    const acknowledgedAt = new Date().toISOString();
    const intakeAck = submission.shippingRequired
      ? {
          acknowledgedAt,
          snapshot: buildAddressAckSnapshot({
            fullName: submission.clientFullName,
            email: submission.clientEmail,
            phone: submission.clientPhone,
            address: {
              street1: submission.shippingStreet,
              street2: submission.shippingStreet2,
              city: submission.shippingCity,
              state: submission.shippingState,
              zip: submission.shippingPostalCode,
              country: submission.shippingCountry,
            },
          }),
          textVersion: CLIENT_ADDRESS_ACK_VERSION,
          formSource: CLIENT_ADDRESS_ACK_FORM,
        }
      : undefined;
    const result = submitClientOrder(token, submission, intakeCheck, intakeAck);
    if (!result.ok) return res.status(result.reason === "invalid" ? 404 : 410).json(result);
    return res.status(201).json({ ok: true });
  });

  app.post("/api/address-capture/preview", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const pasted = text(recordBody(req.body), "text");
    if (pasted.trim().length < 5) return res.status(400).json({ ok: false, error: "Paste a full address." });
    return res.json(capturePayload(await previewPastedAddress(pasted)));
  });

  app.post("/api/address-capture/apply", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const body = recordBody(req.body);
    const fields = body.fields && typeof body.fields === "object" && !Array.isArray(body.fields)
      ? (body.fields as Record<string, unknown>)
      : {};
    const result = await applyCapturedAddress({
      confirm: body.confirm === true,
      dealId: text(body, "dealId"),
      offbookId: typeof body.offbookId === "number" ? body.offbookId : undefined,
      decision: text(body, "decision"),
      noUnit: body.noUnit === true,
      replaceHubspot: body.replaceHubspot === true,
      switchToShip: body.switchToShip === true,
      fields: {
        street1: text(fields, "street1"),
        street2: text(fields, "street2"),
        city: text(fields, "city"),
        state: text(fields, "state"),
        zip: text(fields, "zip"),
        country: text(fields, "country"),
      },
    });
    return send(res, result.ok ? { status: 200, body: result.body } : result);
  });
}
