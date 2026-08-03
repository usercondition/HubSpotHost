/**
 * Print Orders profitability math.
 *
 *   Gross Profit      = amount - material - labor - packaging - shipping
 *   Margin Percentage = (gross profit / amount) * 100, or 0 when amount <= 0
 *
 * Blank / missing / non-numeric inputs are treated as zero. Both outputs are
 * rounded to 2 decimals.
 */

export interface RawDealInputs {
  amount?: unknown;
  print_material_cost?: unknown;
  print_labor_cost?: unknown;
  print_packaging_cost?: unknown;
  print_actual_shipping_cost?: unknown;
}

export interface NormalizedInputs {
  amount: number;
  material: number;
  labor: number;
  packaging: number;
  shipping: number;
}

export interface CalcResult extends NormalizedInputs {
  costTotal: number;
  grossProfit: number;
  marginPercentage: number;
}

/** Coerce a HubSpot property value to a finite number; blank/invalid -> 0. */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return 0;
    // tolerate thousands separators and currency-free numeric strings
    const parsed = Number(trimmed.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function normalizeInputs(raw: RawDealInputs): NormalizedInputs {
  return {
    amount: toNumber(raw.amount),
    material: toNumber(raw.print_material_cost),
    labor: toNumber(raw.print_labor_cost),
    packaging: toNumber(raw.print_packaging_cost),
    shipping: toNumber(raw.print_actual_shipping_cost),
  };
}

export function calculateProfit(raw: RawDealInputs): CalcResult {
  const inputs = normalizeInputs(raw);
  const costTotal = round2(
    inputs.material + inputs.labor + inputs.packaging + inputs.shipping,
  );
  const grossProfit = round2(
    inputs.amount - inputs.material - inputs.labor - inputs.packaging - inputs.shipping,
  );
  const marginPercentage =
    inputs.amount > 0 ? round2((grossProfit / inputs.amount) * 100) : 0;

  return { ...inputs, costTotal, grossProfit, marginPercentage };
}

/** HubSpot expects string property values on PATCH. */
export function toOutputProperties(result: CalcResult): Record<string, string> {
  return {
    print_gross_profit: result.grossProfit.toFixed(2),
    print_margin_percentage: result.marginPercentage.toFixed(2),
  };
}
