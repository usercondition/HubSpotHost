/**
 * Address capture, buyer-form checks, and the label ship-to gate.
 * Registered from routes.ts so that file does not grow.
 */
import type { Express, Request, Response } from "express";
import {
  CLIENT_ADDRESS_ACK_FORM,
  CLIENT_ADDRESS_ACK_VERSION,
  buildAddressAckSnapshot,
} from "../../shared/address-ack";
import { publicAddressFieldsSchema } from "../../shared/address-capture";
import { clientOrderSubmissionSchema } from "../../shared/schema";
import { addressEntryLabelFor } from "./address-ack";
import {
  applyCapturedAddress,
  capturePayload,
  checkCapturedAddress,
  prepareClientAddressSubmit,
  previewPastedAddress,
} from "./address-capture";
import { PublicAddressRateLimitError, ensureAddressCheck } from "./address-checks";
import { addressProviderStatus, suggestFromProvider } from "./address-provider";
import { consumeClientAttempt } from "./client-rate-limit";
import { fetchDealAssociatedContact } from "./deal-ops";
import { HUBSPOT_BUSY_MESSAGE, HubSpotError, isHubSpotBusyError } from "./hubspot";
import { applyAddressCleanup, gateLabelAddress, listAddressAudit, verifyAddressNow } from "./label-address";
import { lookupClientOrder, submitClientOrder } from "./order-links";
import { attachShippingLabelToDeals } from "./shipping-label-attach";
import {
  ShipEngineError,
  buildShipNotesFromShipEngine,
  createShipEngineRates,
  getShipFromAddress,
  getShipEngineStatus,
  purchaseShipEngineLabel,
  shipEnginePurchaseRequestSchema,
  shipEngineRatesRequestSchema,
} from "./shipengine";
import { firstIssue } from "./validation";

const PLACES_SESSION = /^[A-Za-z0-9_-]{16,80}$/;
const BOUGHT_LABEL_WARNING = "Label bought; the follow-up contact read failed";

function tokenFromBody(body: unknown): string {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const token = typeof record.token === "string" ? record.token.trim() : "";
  return /^[A-Za-z0-9_-]{16,200}$/.test(token) ? token : "";
}

function tooManyClientAttempts(req: Request, res: Response): boolean {
  if (!consumeClientAttempt(req.ip || "unknown")) return false;
  res.status(429).json({ ok: false, reason: "throttled" });
  return true;
}

function boughtLabelBody(
  dealIds: string[],
  purchase: Awaited<ReturnType<typeof purchaseShipEngineLabel>>,
  warning: string,
) {
  return {
    ok: true,
    attachedDealIds: dealIds,
    contact: { id: null, name: "", email: "" },
    buyerEmail: null,
    marketplaceSend: null,
    warning,
    shipengine: {
      labelId: purchase.labelId,
      trackingNumber: purchase.trackingNumber,
      trackingUrl: purchase.trackingUrl,
      labelUrl: purchase.labelUrl,
      amount: purchase.amount,
      currency: purchase.currency,
      carrierCode: purchase.carrierCode,
      serviceCode: purchase.serviceCode,
      testMode: purchase.testMode,
    },
  };
}

export function registerLabelAddressRoutes(
  app: Express,
  rejectOwner: (req: Request, res: Response) => boolean,
) {
  app.get("/api/address-entry", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const orderKey = typeof req.query.orderKey === "string" ? req.query.orderKey : "";
    if (!/^(deal|offbook):[0-9]{1,20}$/.test(orderKey)) {
      return res.status(400).json({ ok: false, error: "Unknown order." });
    }
    return res.json({ ok: true, addressEntryLabel: addressEntryLabelFor(orderKey) });
  });

  /** Structured HubSpot ship-to for rate shopping. */
  app.get("/api/shipping-labels/ship-to/:dealId", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    }
    try {
      const contact = await fetchDealAssociatedContact(dealId);
      const ensured = await ensureAddressCheck({ dealId, contact });
      const cleaned = ensured.normalized;
      const address = ensured.address;
      const missing = address
        ? []
        : [
            !contact.name && "name",
            !cleaned.normalized.street1 && "street",
            !cleaned.normalized.city && "city",
            !cleaned.normalized.state && "state",
            !cleaned.normalized.zip && "zip",
          ].filter(Boolean);
      return res.json({
        ok: true,
        dealId,
        contact: {
          id: contact.id,
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          addressLines: contact.addressLines,
          street1: contact.street1,
          street2: contact.street2,
          city: contact.city,
          state: contact.state,
          zip: contact.zip,
          country: contact.country,
        },
        original: cleaned.original,
        normalized: cleaned.normalized,
        needsCleanup: cleaned.changed,
        changes: cleaned.changes,
        validation: {
          status: ensured.status,
          checkedAt: ensured.checkedAt,
          addressHash: ensured.addressHash,
          suggestion: ensured.matched,
          messages: ensured.messages,
        },
        addressEntryLabel: addressEntryLabelFor(`deal:${dealId}`),
        ready: Boolean(address),
        hasContact: Boolean(contact.id),
        missing,
      });
    } catch (error) {
      if (isHubSpotBusyError(error)) {
        return res.status(503).json({ ok: false, error: HUBSPOT_BUSY_MESSAGE });
      }
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not load ship-to address",
      });
    }
  });

  /** Quote carrier rates via ShipEngine for a Print Order's HubSpot ship-to. */
  app.post("/api/shipping-labels/shipengine/rates", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = shipEngineRatesRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const status = getShipEngineStatus();
    if (!status.hasApiKey) {
      return res.status(503).json({
        ok: false,
        error: "Add SHIPENGINE_API_KEY on Railway (ShipStation API → API Keys).",
      });
    }
    const addressFrom = parsed.data.addressFrom
      ? {
          name: parsed.data.addressFrom.name,
          street1: parsed.data.addressFrom.street1,
          street2: parsed.data.addressFrom.street2 || undefined,
          city: parsed.data.addressFrom.city,
          state: parsed.data.addressFrom.state,
          zip: parsed.data.addressFrom.zip,
          country: parsed.data.addressFrom.country || "US",
          phone: parsed.data.addressFrom.phone || undefined,
          email: parsed.data.addressFrom.email || undefined,
        }
      : getShipFromAddress();
    if (!addressFrom) {
      return res.status(503).json({
        ok: false,
        error:
          "Set SHIP_FROM_NAME, SHIP_FROM_STREET1, SHIP_FROM_CITY, SHIP_FROM_STATE, and SHIP_FROM_ZIP on Railway.",
      });
    }

    try {
      const contact = await fetchDealAssociatedContact(parsed.data.dealId);
      const gated = await gateLabelAddress(contact, parsed.data.addressDecision, parsed.data.dealId);
      if (!gated.ok) {
        return res.status(gated.status).json(gated.body);
      }
      const addressTo = gated.address;
      const quoted = await createShipEngineRates({
        addressFrom,
        addressTo,
        parcel: parsed.data.parcel,
      });
      return res.json({
        ok: true,
        dealId: parsed.data.dealId,
        testMode: quoted.testMode,
        shipmentId: quoted.shipmentId,
        addressTo: {
          name: addressTo.name,
          street1: addressTo.street1,
          city: addressTo.city,
          state: addressTo.state,
          zip: addressTo.zip,
        },
        original: gated.normalized.original,
        normalized: gated.normalized.normalized,
        rates: quoted.rates,
        messages: quoted.messages,
      });
    } catch (error) {
      if (isHubSpotBusyError(error)) {
        return res.status(503).json({ ok: false, error: HUBSPOT_BUSY_MESSAGE });
      }
      const statusCode = error instanceof ShipEngineError ? error.status : 502;
      return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 502).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not get ShipEngine rates",
      });
    }
  });

  /**
   * Buy a ShipEngine rate, then attach tracking. The address is gated before
   * any charge. Once the label is paid for, a failed follow-up contact read
   * still returns the label URL.
   */
  app.post("/api/shipping-labels/shipengine/purchase", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = shipEnginePurchaseRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    if (!getShipEngineStatus().hasApiKey) {
      return res.status(503).json({
        ok: false,
        error: "Add SHIPENGINE_API_KEY on Railway before buying labels.",
      });
    }

    let purchase: Awaited<ReturnType<typeof purchaseShipEngineLabel>> | null = null;
    try {
      const contact = await fetchDealAssociatedContact(parsed.data.dealIds[0]!, { fresh: true });
      const gated = await gateLabelAddress(contact, parsed.data.addressDecision, parsed.data.dealIds[0]);
      if (!gated.ok) {
        return res.status(gated.status).json(gated.body);
      }
      purchase = await purchaseShipEngineLabel({ rateId: parsed.data.rateId });
      const recipientName = contact.name || null;
      const notes = buildShipNotesFromShipEngine({
        carrierCode: purchase.carrierCode || parsed.data.carrierCode,
        serviceType: purchase.serviceCode || parsed.data.serviceType,
        amount: purchase.amount || parsed.data.amount,
        labelUrl: purchase.labelUrl,
        recipientName,
      });
      const postageUsd = purchase.amount || parsed.data.amount || "";
      const label = {
        labelId: purchase.labelId,
        trackingNumber: purchase.trackingNumber,
        trackingUrl: purchase.trackingUrl,
        labelUrl: purchase.labelUrl,
        amount: postageUsd,
        currency: purchase.currency,
        carrierCode: purchase.carrierCode || parsed.data.carrierCode,
        serviceCode: purchase.serviceCode || parsed.data.serviceType,
        testMode: purchase.testMode,
      };
      try {
        const attached = await attachShippingLabelToDeals({
          dealIds: parsed.data.dealIds,
          trackingNumber: purchase.trackingNumber,
          notes,
          postageUsd,
          packingDone: parsed.data.packingDone,
          labelBought: true,
          markComplete: true,
          messageChannel: parsed.data.messageChannel,
          liveWrite: parsed.data.liveWrite,
          shipengine: {
            labelId: purchase.labelId,
            carrier: purchase.carrierCode,
            service: purchase.serviceCode,
          },
        });
        if (!attached.ok) {
          return res.status(400).json({ ...attached, shipengine: label });
        }
        return res.json({ ...attached, shipengine: label });
      } catch (error) {
        return res.status(200).json(
          boughtLabelBody(
            parsed.data.dealIds,
            purchase,
            error instanceof Error ? error.message : BOUGHT_LABEL_WARNING,
          ),
        );
      }
    } catch (error) {
      if (purchase) {
        return res.status(200).json(
          boughtLabelBody(
            parsed.data.dealIds,
            purchase,
            error instanceof Error ? error.message : BOUGHT_LABEL_WARNING,
          ),
        );
      }
      if (isHubSpotBusyError(error)) {
        return res.status(503).json({ ok: false, error: HUBSPOT_BUSY_MESSAGE });
      }
      const statusCode = error instanceof ShipEngineError ? error.status : 502;
      return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 502).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not purchase ShipEngine label",
      });
    }
  });

  /** Force a ShipEngine check for this deal, even when the stored hash still matches. */
  app.post("/api/shipping-labels/address-verify", async (req: Request, res: Response) => {
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
      if (isHubSpotBusyError(error)) {
        return res.status(503).json({ ok: false, error: HUBSPOT_BUSY_MESSAGE });
      }
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not verify the address",
      });
    }
  });

  /** Write cleaned address fields to the HubSpot contact. Confirm is required. */
  app.post("/api/shipping-labels/address-cleanup", async (req: Request, res: Response) => {
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
      if (isHubSpotBusyError(error)) {
        return res.status(503).json({ ok: false, error: HUBSPOT_BUSY_MESSAGE });
      }
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not clean up the HubSpot address",
      });
    }
  });

  /** Open orders whose address needs cleanup or failed validation. */
  app.get("/api/shipping-labels/address-audit", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    try {
      const rows = await listAddressAudit();
      return res.json({ ok: true, rows });
    } catch (error) {
      if (isHubSpotBusyError(error)) {
        return res.status(503).json({ ok: false, error: HUBSPOT_BUSY_MESSAGE });
      }
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not audit addresses",
      });
    }
  });

  /**
   * Tells the buyer form whether address suggestions are on.
   * The provider is off unless GOOGLE_PLACES_API_KEY is set. The key is never sent.
   */
  app.get("/api/address-provider", (_req: Request, res: Response) => {
    return res.json({ ok: true, provider: addressProviderStatus() });
  });

  /**
   * Public address suggestions. Empty unless the Google Places provider is enabled,
   * and then only US addresses. Throttled with the other client routes.
   */
  app.post("/api/address-suggest", async (req: Request, res: Response) => {
    if (tooManyClientAttempts(req, res)) return;
    const token = tokenFromBody(req.body);
    if (!token) return res.status(404).json({ ok: false, reason: "invalid" });
    const lookup = lookupClientOrder(token);
    if (!lookup.ok) return res.status(lookup.reason === "invalid" ? 404 : 410).json(lookup);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
    const query = typeof body.query === "string" ? body.query : "";
    const sessionToken = typeof body.sessionToken === "string" ? body.sessionToken.trim() : "";
    if (!PLACES_SESSION.test(sessionToken)) {
      return res.status(400).json({ ok: false, error: "A Places session token is required." });
    }
    try {
      const suggestions = await suggestFromProvider(query.slice(0, 160), process.env, sessionToken);
      return res.json({ ok: true, suggestions, provider: addressProviderStatus(), sessionToken });
    } catch {
      return res.json({ ok: true, suggestions: [], provider: addressProviderStatus(), sessionToken });
    }
  });

  /** Public: ShipEngine check for the buyer form. Does not save the order. */
  app.post("/api/client-order/validate-address", async (req: Request, res: Response) => {
    if (tooManyClientAttempts(req, res)) return;
    const token = tokenFromBody(req.body);
    if (!token) return res.status(404).json({ ok: false, reason: "invalid" });
    const lookup = lookupClientOrder(token);
    if (!lookup.ok) return res.status(lookup.reason === "invalid" ? 404 : 410).json(lookup);
    const parsedAddress = publicAddressFieldsSchema.safeParse(req.body ?? {});
    if (!parsedAddress.success) {
      return res.status(400).json({ ok: false, reason: "invalid-details", error: firstIssue(parsedAddress.error) });
    }
    try {
      const check = await checkCapturedAddress(
        {
          street1: parsedAddress.data.shippingStreet,
          street2: parsedAddress.data.shippingStreet2,
          city: parsedAddress.data.shippingCity,
          state: parsedAddress.data.shippingState,
          zip: parsedAddress.data.shippingPostalCode,
          country: parsedAddress.data.shippingCountry,
        },
        { audience: "public", rateKey: req.ip || "unknown" },
      );
      return res.json(capturePayload(check));
    } catch (error) {
      if (error instanceof PublicAddressRateLimitError) {
        return res.status(429).json({ ok: false, reason: "throttled" });
      }
      throw error;
    }
  });

  /**
   * Public: one buyer submission per link. This writes ONLY to the local
   * SQLite queue — it never calls HubSpot. A shipping address is checked with
   * ShipEngine first. A correction or a missing unit is not stored until the
   * buyer picks one.
   */
  app.post("/api/client-order/submit", async (req: Request, res: Response) => {
    if (tooManyClientAttempts(req, res)) return;
    const token = tokenFromBody(req.body);
    if (!token) return res.status(404).json({ ok: false, reason: "invalid" });
    const parsed = clientOrderSubmissionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, reason: "invalid-details", error: firstIssue(parsed.error) });
    }
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
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
          decision: typeof body.addressDecision === "string" ? body.addressDecision : "",
          noUnit: body.noUnit === true,
          addressCheckToken: typeof body.addressCheckToken === "string" ? body.addressCheckToken : "",
          addressAcknowledged: body.addressAcknowledged === true,
          rateKey: req.ip || "unknown",
        });
      } catch (error) {
        if (error instanceof PublicAddressRateLimitError) {
          return res.status(429).json({ ok: false, reason: "throttled" });
        }
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

  /** Owner: parse a pasted address, validate it, and return it for confirmation. Does not save. */
  app.post("/api/address-capture/preview", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const text =
      req.body && typeof req.body === "object" && typeof (req.body as { text?: unknown }).text === "string"
        ? String((req.body as { text: string }).text)
        : "";
    if (text.trim().length < 5) {
      return res.status(400).json({ ok: false, error: "Paste a full address." });
    }
    const check = await previewPastedAddress(text);
    return res.json(capturePayload(check));
  });

  /** Owner: save a confirmed address onto a deal contact or an off-book row. */
  app.post("/api/address-capture/apply", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
    const fields = body.fields && typeof body.fields === "object" && !Array.isArray(body.fields)
      ? (body.fields as Record<string, unknown>)
      : {};
    const text = (row: Record<string, unknown>, key: string) => (typeof row[key] === "string" ? row[key] : "");
    const result = await applyCapturedAddress({
      confirm: body.confirm === true,
      dealId: typeof body.dealId === "string" ? body.dealId : "",
      offbookId: typeof body.offbookId === "number" ? body.offbookId : undefined,
      decision: typeof body.decision === "string" ? body.decision : "",
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
    return res.status(result.ok ? 200 : result.status).json(result.body);
  });
}
