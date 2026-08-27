/**
 * Shop cost policy for Print Orders.
 *
 * Labor is absorbed (owner time not billed into deal costs).
 * Packaging uses free USPS Large Flat Rate boxes → $0.
 * Print Ops seeds labor and packaging as $0 when a plate is attached. Shipping
 * becomes required only after a label is attached, because postage is not known
 * while a job is still being printed.
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
  options: { requiresPlates: boolean; hasPlates: boolean; shippingRequired: boolean },
): boolean {
  if (
    options.requiresPlates &&
    options.hasPlates &&
    (isBlank(props.print_material_cost) ||
      isBlank(props.print_labor_cost) ||
      isBlank(props.print_packaging_cost))
  ) {
    return true;
  }
  return options.shippingRequired && isBlank(props.print_actual_shipping_cost);
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

export function defaultDealCostFields(): {
  material: string;
  labor: string;
  packaging: string;
  shipping: string;
} {
  return { material: "", labor: ABSORBED_LABOR_COST, packaging: FREE_PACKAGING_COST, shipping: "" };
}
