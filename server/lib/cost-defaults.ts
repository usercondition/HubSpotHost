/**
 * Propose and apply deal cost defaults from attached plate data.
 * Every HubSpot write requires an explicit confirm — never automatic.
 */

import { getConfig, resolveWriteDecision } from "./config";
import { HubSpotError, fetchDealInputs, patchDealOutputs } from "./hubspot";
import { listPrintFileRecords } from "./print-files";
import { recalculateDeal } from "./service";

export const DEFAULT_LABOR_RATE_USD_PER_HOUR = 25;
export const DEFAULT_PACKAGING_USD = 5;

export type CostDefaultField = "material" | "labor" | "packaging" | "shipping";

export type CostFieldProposal = {
  field: CostDefaultField;
  property: string;
  label: string;
  proposed: number | null;
  current: number | null;
  source: string;
  willWrite: boolean;
  skipReason: string | null;
};

export type CostDefaultsPreview = {
  dealId: string;
  dealName: string;
  plateCount: number;
  totalPrintHours: number | null;
  totalResinCost: number | null;
  laborRatePerHour: number;
  packagingAmount: number;
  fields: CostFieldProposal[];
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseCost(raw: string | null | undefined): number | null {
  if (raw == null || String(raw).trim() === "") return null;
  const value = Number(String(raw).replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function getDefaultLaborRatePerHour(): number {
  return envNumber("COST_DEFAULT_LABOR_RATE_USD_PER_HOUR", DEFAULT_LABOR_RATE_USD_PER_HOUR);
}

export function getDefaultPackagingAmount(): number {
  return envNumber("COST_DEFAULT_PACKAGING_USD", DEFAULT_PACKAGING_USD);
}

export function summarizeDealPlates(dealId: string): {
  plateCount: number;
  totalPrintTimeSeconds: number | null;
  totalResinCost: number | null;
  dealName: string;
} {
  const records = listPrintFileRecords(500).filter((record) => record.hubspotDealId === dealId);
  const times = records
    .map((record) => record.printTimeSeconds)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const costs = records
    .map((record) => parseCost(record.resinCost))
    .filter((value): value is number => value != null);

  return {
    plateCount: records.length,
    totalPrintTimeSeconds: times.length > 0 ? times.reduce((sum, value) => sum + value, 0) : null,
    totalResinCost: costs.length > 0 ? round2(costs.reduce((sum, value) => sum + value, 0)) : null,
    dealName: records[0]?.hubspotDealName || `Deal ${dealId}`,
  };
}

/** Pure helper for unit tests and preview assembly. */
export function buildCostFieldProposal(input: {
  field: CostDefaultField;
  property: string;
  label: string;
  proposed: number | null;
  current: number | null;
  source: string;
  include: boolean;
  overwrite: boolean;
}): CostFieldProposal {
  if (!input.include) {
    return {
      field: input.field,
      property: input.property,
      label: input.label,
      proposed: input.proposed,
      current: input.current,
      source: input.source,
      willWrite: false,
      skipReason: "Not selected",
    };
  }
  if (input.proposed == null || !(input.proposed > 0)) {
    return {
      field: input.field,
      property: input.property,
      label: input.label,
      proposed: input.proposed,
      current: input.current,
      source: input.source,
      willWrite: false,
      skipReason: "No value available",
    };
  }
  if (input.current != null && input.current > 0 && !input.overwrite) {
    return {
      field: input.field,
      property: input.property,
      label: input.label,
      proposed: input.proposed,
      current: input.current,
      source: input.source,
      willWrite: false,
      skipReason: `Already set to $${input.current.toFixed(2)}`,
    };
  }
  return {
    field: input.field,
    property: input.property,
    label: input.label,
    proposed: round2(input.proposed),
    current: input.current,
    source: input.source,
    willWrite: true,
    skipReason: null,
  };
}

export function assembleCostDefaultsPreview(input: {
  dealId: string;
  dealName: string;
  plateCount: number;
  totalPrintTimeSeconds: number | null;
  totalResinCost: number | null;
  currentMaterial: number | null;
  currentLabor: number | null;
  currentPackaging: number | null;
  currentShipping: number | null;
  laborRatePerHour: number;
  packagingAmount: number;
  shippingAmount?: number | null;
  includeMaterial?: boolean;
  includeLabor?: boolean;
  includePackaging?: boolean;
  includeShipping?: boolean;
  overwriteExisting?: boolean;
}): CostDefaultsPreview {
  const hours =
    input.totalPrintTimeSeconds != null && input.totalPrintTimeSeconds > 0
      ? input.totalPrintTimeSeconds / 3_600
      : null;
  const laborProposed = hours != null ? round2(hours * input.laborRatePerHour) : null;
  const overwrite = Boolean(input.overwriteExisting);

  const fields = [
    buildCostFieldProposal({
      field: "material",
      property: "print_material_cost",
      label: "Material cost",
      proposed: input.totalResinCost,
      current: input.currentMaterial,
      source:
        input.plateCount > 0
          ? `Sum of ${input.plateCount} attached plate resin estimate${input.plateCount === 1 ? "" : "s"}`
          : "Attach CTB plates first",
      include: input.includeMaterial !== false,
      overwrite,
    }),
    buildCostFieldProposal({
      field: "labor",
      property: "print_labor_cost",
      label: "Labor cost",
      proposed: laborProposed,
      current: input.currentLabor,
      source:
        hours != null
          ? `${hours.toFixed(2)} print hours × $${input.laborRatePerHour.toFixed(2)}/hr`
          : "No print time on attached plates",
      include: input.includeLabor !== false,
      overwrite,
    }),
    buildCostFieldProposal({
      field: "packaging",
      property: "print_packaging_cost",
      label: "Packaging cost",
      proposed: input.packagingAmount > 0 ? input.packagingAmount : null,
      current: input.currentPackaging,
      source: `Flat default $${input.packagingAmount.toFixed(2)}`,
      include: input.includePackaging !== false,
      overwrite,
    }),
    buildCostFieldProposal({
      field: "shipping",
      property: "print_actual_shipping_cost",
      label: "Shipping cost",
      proposed:
        input.shippingAmount != null && input.shippingAmount > 0 ? round2(input.shippingAmount) : null,
      current: input.currentShipping,
      source: "Paste Pirate Ship postage when you buy the label",
      include: Boolean(input.includeShipping),
      overwrite,
    }),
  ];

  return {
    dealId: input.dealId,
    dealName: input.dealName,
    plateCount: input.plateCount,
    totalPrintHours: hours != null ? round2(hours) : null,
    totalResinCost: input.totalResinCost,
    laborRatePerHour: input.laborRatePerHour,
    packagingAmount: input.packagingAmount,
    fields,
  };
}

export async function previewCostDefaults(input: {
  dealId: string;
  laborRatePerHour?: number;
  packagingAmount?: number;
  shippingAmount?: number | null;
  includeMaterial?: boolean;
  includeLabor?: boolean;
  includePackaging?: boolean;
  includeShipping?: boolean;
  overwriteExisting?: boolean;
}): Promise<CostDefaultsPreview> {
  const plates = summarizeDealPlates(input.dealId);
  const props = await fetchDealInputs(input.dealId);
  const dealName = plates.dealName || `Deal ${input.dealId}`;

  return assembleCostDefaultsPreview({
    dealId: input.dealId,
    dealName,
    plateCount: plates.plateCount,
    totalPrintTimeSeconds: plates.totalPrintTimeSeconds,
    totalResinCost: plates.totalResinCost,
    currentMaterial: parseCost(props.print_material_cost as string | null | undefined),
    currentLabor: parseCost(props.print_labor_cost as string | null | undefined),
    currentPackaging: parseCost(props.print_packaging_cost as string | null | undefined),
    currentShipping: parseCost(props.print_actual_shipping_cost as string | null | undefined),
    laborRatePerHour: input.laborRatePerHour ?? getDefaultLaborRatePerHour(),
    packagingAmount: input.packagingAmount ?? getDefaultPackagingAmount(),
    shippingAmount: input.shippingAmount,
    includeMaterial: input.includeMaterial,
    includeLabor: input.includeLabor,
    includePackaging: input.includePackaging,
    includeShipping: input.includeShipping,
    overwriteExisting: input.overwriteExisting,
  });
}

export async function applyCostDefaults(input: {
  dealId: string;
  confirm: boolean;
  laborRatePerHour?: number;
  packagingAmount?: number;
  shippingAmount?: number | null;
  includeMaterial?: boolean;
  includeLabor?: boolean;
  includePackaging?: boolean;
  includeShipping?: boolean;
  overwriteExisting?: boolean;
}): Promise<{
  preview: CostDefaultsPreview;
  written: Array<{ property: string; value: number }>;
  recalculated: boolean;
}> {
  if (!input.confirm) {
    throw new HubSpotError("Confirm before writing cost defaults to HubSpot", 400);
  }

  const preview = await previewCostDefaults(input);
  const toWrite = preview.fields.filter((field) => field.willWrite && field.proposed != null);
  if (toWrite.length === 0) {
    throw new HubSpotError("Nothing to write — select fields with available values, or enable overwrite", 400);
  }

  const config = getConfig();
  const decision = resolveWriteDecision(config, true);
  if (!decision.write) {
    throw new HubSpotError(`HubSpot writes are blocked: ${decision.reason}`, 503);
  }

  const properties: Record<string, string> = {};
  for (const field of toWrite) {
    properties[field.property] = String(field.proposed);
  }

  await patchDealOutputs(input.dealId, properties);

  const recalc = await recalculateDeal({
    dealId: input.dealId,
    origin: "manual",
    requestWantsLiveWrite: true,
  });

  return {
    preview,
    written: toWrite.map((field) => ({ property: field.property, value: field.proposed! })),
    recalculated: recalc.status === "written",
  };
}
