/**
 * Deal-level ops: costs, stage moves, packing slip, plate↔printer assignment.
 * HubSpot remains system of record for CRM fields; local data fills shop floor.
 */
import { desc, eq } from "drizzle-orm";
import {
  printFileRecords,
  type AdvanceDealStageInput,
  type AssignPlatePrinterInput,
  type DealCostFields,
  type DealOpsDetail,
  type PackingSlip,
  type UpdateDealCostsInput,
} from "../../shared/schema";
import { calculateProfit } from "./calc";
import { getConfig, resolveWriteDecision } from "./config";
import { getFulfillmentChecklist } from "./fulfillment";
import { listFailuresForDeal } from "./failures";
import {
  fetchHubSpotPortalId,
  fetchPrintOrderPipelineStages,
  hubspotRequest,
  HubSpotError,
  invalidatePrintOrderDealsCache,
  PRINT_ORDERS_PIPELINE,
} from "./hubspot";
import { getKitForDeal } from "./kits";
import { getDb } from "./order-links";
import {
  ensureDefaultPrinters,
  listPrinterProfileMaps,
  resolvePrinterIdForRecord,
} from "./printers";
import { recalculateDeal } from "./service";

function moneyText(value: string | null | undefined): string {
  if (value == null || String(value).trim() === "") return "";
  const n = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? String(n) : "";
}

function parseGrams(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stageClosed(metadata: Record<string, unknown>): boolean {
  const raw = metadata?.isClosed ?? metadata?.is_closed;
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

async function fetchDealWithCosts(dealId: string): Promise<{
  id: string;
  properties: Record<string, string | null>;
}> {
  const query = new URLSearchParams({
    properties: [
      "dealname",
      "amount",
      "dealstage",
      "pipeline",
      "closedate",
      "print_material_cost",
      "print_labor_cost",
      "print_packaging_cost",
      "print_actual_shipping_cost",
      "print_gross_profit",
      "print_margin_percentage",
      "description",
    ].join(","),
  });
  const data = await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?${query}`, {
    method: "GET",
  });
  return {
    id: String(data.id),
    properties: (data.properties ?? {}) as Record<string, string | null>,
  };
}

export async function fetchDealAssociatedContact(dealId: string): Promise<{
  id: string | null;
  name: string;
  email: string;
  phone: string;
  addressLines: string[];
}> {
  try {
    const assoc = await hubspotRequest(
      `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/contacts?limit=1`,
      { method: "GET" },
    );
    const results = Array.isArray(assoc?.results) ? assoc.results : [];
    const contactId =
      typeof results[0]?.toObjectId === "string"
        ? results[0].toObjectId
        : typeof results[0]?.id === "string"
          ? results[0].id
          : null;
    if (!contactId) {
      return { id: null, name: "", email: "", phone: "", addressLines: [] };
    }
    const contact = await hubspotRequest(
      `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=firstname,lastname,email,phone,address,city,state,zip,country`,
      { method: "GET" },
    );
    const props = (contact.properties ?? {}) as Record<string, string | null>;
    const name = [props.firstname, props.lastname].filter(Boolean).join(" ").trim();
    const addressLines = [
      props.address,
      [props.city, props.state, props.zip].filter(Boolean).join(", "),
      props.country,
    ]
      .map((line) => String(line ?? "").trim())
      .filter(Boolean);
    return {
      id: contactId,
      name,
      email: String(props.email ?? "").trim(),
      phone: String(props.phone ?? "").trim(),
      addressLines,
    };
  } catch {
    return { id: null, name: "", email: "", phone: "", addressLines: [] };
  }
}

/** @deprecated use fetchDealAssociatedContact */
async function fetchAssociatedContact(dealId: string) {
  return fetchDealAssociatedContact(dealId);
}

function costsFromProperties(props: Record<string, string | null>): DealCostFields {
  const calc = calculateProfit(props);
  const material = moneyText(props.print_material_cost);
  const labor = moneyText(props.print_labor_cost);
  const packaging = moneyText(props.print_packaging_cost);
  const shipping = moneyText(props.print_actual_shipping_cost);
  return {
    amount: calc.amount,
    material,
    labor,
    packaging,
    shipping,
    grossProfit: Number.isFinite(calc.grossProfit) ? calc.grossProfit : null,
    marginPercentage: Number.isFinite(calc.marginPercentage) ? calc.marginPercentage : null,
    costsComplete: Boolean(material && labor && packaging && shipping),
  };
}

export function assignPlateToPrinter(
  input: AssignPlatePrinterInput,
): { ok: true; recordId: number; assignedPrinterId: number | null; assignedPrinterName: string | null } | { ok: false; error: string } {
  const record = getDb().select().from(printFileRecords).where(eq(printFileRecords.id, input.recordId)).get();
  if (!record) return { ok: false, error: "Plate record not found." };

  const fleet = ensureDefaultPrinters();
  let fleetPrinterId: number | null = input.printerId;
  let assignedPrinterName: string | null = null;
  if (fleetPrinterId != null) {
    const printer = fleet.find((item) => item.id === fleetPrinterId);
    if (!printer) return { ok: false, error: "Choose a fleet printer." };
    assignedPrinterName = printer.name;
  }

  getDb()
    .update(printFileRecords)
    .set({ fleetPrinterId })
    .where(eq(printFileRecords.id, input.recordId))
    .run();

  // API keeps assignedPrinter* names for DealOpsPanel; DB column is fleet_printer_id.
  return { ok: true, recordId: input.recordId, assignedPrinterId: fleetPrinterId, assignedPrinterName };
}

export async function updateDealCosts(
  dealId: string,
  input: UpdateDealCostsInput,
): Promise<
  | { ok: true; dryRun: boolean; gate: string; costs: DealCostFields; recalcStatus: string }
  | { ok: false; error: string; status?: number }
> {
  const id = dealId.trim();
  if (!/^[0-9]{1,20}$/.test(id)) return { ok: false, error: "Select a valid Print Order.", status: 400 };

  const config = getConfig();
  const decision = resolveWriteDecision(config, input.liveWrite !== false);
  const properties: Record<string, string> = {};
  const assign = (key: string, raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const n = Number(trimmed.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) return;
    properties[key] = String(n);
  };
  assign("print_material_cost", input.material);
  assign("print_labor_cost", input.labor);
  assign("print_packaging_cost", input.packaging);
  assign("print_actual_shipping_cost", input.shipping);

  if (Object.keys(properties).length === 0) {
    return { ok: false, error: "Enter at least one cost field.", status: 400 };
  }

  try {
    if (decision.write) {
      await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      });
      invalidatePrintOrderDealsCache();
      const recalc = await recalculateDeal({
        dealId: id,
        origin: "manual",
        requestWantsLiveWrite: true,
      });
      const deal = await fetchDealWithCosts(id);
      return {
        ok: true,
        dryRun: false,
        gate: decision.reason,
        costs: costsFromProperties(deal.properties),
        recalcStatus: recalc.status,
      };
    }

    // Dry-run preview: merge proposed costs onto current deal props without writing.
    const deal = await fetchDealWithCosts(id);
    const previewProps = { ...deal.properties, ...properties };
    const calc = calculateProfit(previewProps);
    return {
      ok: true,
      dryRun: true,
      gate: decision.reason,
      costs: {
        ...costsFromProperties(previewProps),
        grossProfit: calc.grossProfit,
        marginPercentage: calc.marginPercentage,
      },
      recalcStatus: "dry-run",
    };
  } catch (error) {
    const message = error instanceof HubSpotError ? error.message : "Could not update deal costs.";
    const status = error instanceof HubSpotError ? error.status : 502;
    return { ok: false, error: message, status };
  }
}

export async function advanceDealStage(
  dealId: string,
  input: AdvanceDealStageInput,
): Promise<
  | { ok: true; dryRun: boolean; gate: string; stageId: string; stageLabel: string }
  | { ok: false; error: string; status?: number }
> {
  const id = dealId.trim();
  if (!/^[0-9]{1,20}$/.test(id)) return { ok: false, error: "Select a valid Print Order.", status: 400 };

  const stages = await fetchPrintOrderPipelineStages();
  const target = stages.find((stage) => stage.id === input.stageId.trim());
  if (!target) return { ok: false, error: "That stage is not on the Print Orders pipeline.", status: 400 };

  const config = getConfig();
  const decision = resolveWriteDecision(config, input.liveWrite !== false);

  try {
    if (decision.write) {
      await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            pipeline: PRINT_ORDERS_PIPELINE,
            dealstage: target.id,
          },
        }),
      });
      invalidatePrintOrderDealsCache();
    }
    return {
      ok: true,
      dryRun: !decision.write,
      gate: decision.reason,
      stageId: target.id,
      stageLabel: target.label,
    };
  } catch (error) {
    const message = error instanceof HubSpotError ? error.message : "Could not advance deal stage.";
    const status = error instanceof HubSpotError ? error.status : 502;
    return { ok: false, error: message, status };
  }
}

export async function buildDealOpsDetail(dealId: string): Promise<DealOpsDetail | { error: string; status?: number }> {
  const id = dealId.trim();
  if (!/^[0-9]{1,20}$/.test(id)) return { error: "Select a valid Print Order.", status: 400 };

  try {
    const [deal, stages, portalId, contact] = await Promise.all([
      fetchDealWithCosts(id),
      fetchPrintOrderPipelineStages(),
      fetchHubSpotPortalId(),
      fetchAssociatedContact(id),
    ]);

    const props = deal.properties;
    const stageId = String(props.dealstage ?? "");
    const stageLabel = stages.find((stage) => stage.id === stageId)?.label || stageId || "Unknown";
    const costs = costsFromProperties(props);
    const checklist = getFulfillmentChecklist(id);
    const fleet = ensureDefaultPrinters();
    const profileMaps = listPrinterProfileMaps();
    const plates = getDb()
      .select()
      .from(printFileRecords)
      .where(eq(printFileRecords.hubspotDealId, id))
      .orderBy(desc(printFileRecords.attachedAt), desc(printFileRecords.id))
      .all();

    const plateViews = plates.map((plate) => {
      const assignedId = resolvePrinterIdForRecord(plate, fleet, profileMaps);
      const printer = assignedId != null ? fleet.find((item) => item.id === assignedId) : null;
      return {
        id: plate.id,
        fileName: plate.fileName,
        printerProfile: plate.printerProfile,
        assignedPrinterId: plate.fleetPrinterId ?? assignedId,
        assignedPrinterName: printer?.name ?? null,
        printTimeSeconds: plate.printTimeSeconds,
        resinMassG: parseGrams(plate.resinMassG),
        attachedAt: plate.attachedAt,
      };
    });

    const kit = getKitForDeal(id);
    const kitDoc = kit.kit;
    const lines: PackingSlip["lines"] = [
      {
        kind: "deal",
        label: String(props.dealname ?? `Deal ${id}`),
        detail: costs.amount > 0 ? `$${costs.amount.toFixed(2)}` : "Print order",
      },
    ];
    if (kitDoc) {
      for (const bit of kitDoc.bits) {
        lines.push({
          kind: "kit_bit",
          label: bit.label || bit.fileName,
          detail: bit.group ? `${bit.group} · ${bit.fileName}` : bit.fileName,
          status: bit.status,
        });
      }
    }
    for (const plate of plateViews) {
      lines.push({
        kind: "plate",
        label: plate.fileName,
        detail: plate.assignedPrinterName || plate.printerProfile || "Unassigned printer",
        status: "plate",
      });
    }

    const packingSlip: PackingSlip = {
      dealId: id,
      dealName: String(props.dealname ?? `Deal ${id}`),
      amount: costs.amount,
      stage: stageLabel,
      contact: {
        id: contact.id,
        name: contact.name || checklist.notes || "Buyer",
        email: contact.email,
        phone: contact.phone,
        addressLines: contact.addressLines,
      },
      lines,
      kitSummary: kit.summary
        ? {
            total: kit.summary.totalBits,
            good: kit.summary.good,
            needed: kit.summary.needed,
            reprint: kit.summary.reprint,
          }
        : null,
      plateCount: plateViews.length,
      checklist,
      generatedAt: new Date().toISOString(),
    };

    const config = getConfig();
    const decision = resolveWriteDecision(config, true);

    return {
      dealId: id,
      dealName: String(props.dealname ?? `Deal ${id}`),
      stageId,
      stage: stageLabel,
      amount: costs.amount,
      closeDate: props.closedate ? new Date(Number(props.closedate) || props.closedate).toISOString() : null,
      costs,
      checklist,
      plates: plateViews,
      packingSlip,
      failures: listFailuresForDeal(id).map((row) => ({
        id: row.id,
        failureType: row.failureType,
        notes: row.notes,
        resinMassG: row.resinMassG,
        printerId: row.printerId,
        printFileRecordId: row.printFileRecordId,
        occurredAt: row.occurredAt,
      })),
      stages: stages.map((stage) => ({
        id: stage.id,
        label: stage.label,
        closed: stageClosed(stage.metadata),
      })),
      printers: fleet.map((printer) => ({
        id: printer.id,
        name: printer.name,
        status: printer.status,
      })),
      hubspotPortalId: portalId,
      writeGate: {
        dryRun: config.dryRun,
        allowWrites: config.allowWrites,
        liveWriteReady: decision.write,
      },
    };
  } catch (error) {
    const message = error instanceof HubSpotError ? error.message : "Could not load deal ops.";
    const status = error instanceof HubSpotError ? error.status : 502;
    return { error: message, status };
  }
}
