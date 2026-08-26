/**
 * Shop cost policy for Print Orders.
 *
 * Labor is absorbed (owner time not billed into deal costs).
 * Packaging uses free USPS Large Flat Rate boxes → $0.
 * Nudges / "costs complete" only require material + actual shipping on print deals.
 */

function isBlank(value: unknown): boolean {
  return String(value ?? "").trim() === "";
}

export type DealCostPropertyBag = {
  print_material_cost?: unknown;
  print_labor_cost?: unknown;
  print_packaging_cost?: unknown;
  print_actual_shipping_cost?: unknown;
};

/** True when required actual-cost fields are still empty. */
export function dealCostsIncomplete(
  props: DealCostPropertyBag,
  options: { requiresPlates: boolean },
): boolean {
  if (!options.requiresPlates) {
    return isBlank(props.print_actual_shipping_cost);
  }
  return isBlank(props.print_material_cost) || isBlank(props.print_actual_shipping_cost);
}

/** Whether HubSpot/UI cost entry is "done enough" for ops (labor/packaging optional). */
export function dealCostsCompleteFromFields(fields: {
  material: string;
  labor: string;
  packaging: string;
  shipping: string;
}): boolean {
  return Boolean(fields.material.trim() && fields.shipping.trim());
}

export const ABSORBED_LABOR_COST = "0";
export const FREE_PACKAGING_COST = "0";
