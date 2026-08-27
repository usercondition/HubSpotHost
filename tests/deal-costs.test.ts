import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultDealCostFields,
  dealCostsCompleteFromFields,
  dealCostsIncomplete,
} from "../shared/deal-costs";

test("plated print deals require material, labor, and packaging but not shipping before a label", () => {
  assert.equal(
    dealCostsIncomplete(
      {
        print_material_cost: "12.50",
        print_labor_cost: "0",
        print_packaging_cost: "0",
        print_actual_shipping_cost: "",
      },
      { requiresPlates: true, hasPlates: true, shippingRequired: false },
    ),
    false,
  );
  assert.equal(
    dealCostsIncomplete(
      {
        print_material_cost: "",
        print_labor_cost: "0",
        print_packaging_cost: "0",
        print_actual_shipping_cost: "5.42",
      },
      { requiresPlates: true, hasPlates: true, shippingRequired: true },
    ),
    true,
  );
  assert.equal(
    dealCostsIncomplete(
      {
        print_material_cost: "12",
        print_labor_cost: "",
        print_packaging_cost: "",
        print_actual_shipping_cost: "",
      },
      { requiresPlates: true, hasPlates: true, shippingRequired: false },
    ),
    true,
  );
});

test("shipping is incomplete only after a label requires postage", () => {
  assert.equal(
    dealCostsIncomplete(
      {
        print_material_cost: "",
        print_labor_cost: "",
        print_packaging_cost: "",
        print_actual_shipping_cost: "",
      },
      { requiresPlates: false, hasPlates: false, shippingRequired: false },
    ),
    false,
  );
  assert.equal(
    dealCostsIncomplete(
      {
        print_material_cost: "",
        print_labor_cost: "",
        print_packaging_cost: "",
        print_actual_shipping_cost: "",
      },
      { requiresPlates: false, hasPlates: false, shippingRequired: true },
    ),
    true,
  );
  assert.equal(
    dealCostsIncomplete(
      {
        print_material_cost: "",
        print_actual_shipping_cost: "8",
      },
      { requiresPlates: false, hasPlates: false, shippingRequired: true },
    ),
    false,
  );
});

test("ops complete flag ignores blank absorbed labor and free packaging", () => {
  assert.equal(
    dealCostsCompleteFromFields({
      material: "10",
      labor: "",
      packaging: "",
      shipping: "4",
    }),
    true,
  );
  assert.equal(
    dealCostsCompleteFromFields({
      material: "10",
      labor: "0",
      packaging: "0",
      shipping: "",
    }),
    false,
  );
});

test("Print Ops cost UI defaults labor and free USPS packaging to zero", () => {
  assert.deepEqual(defaultDealCostFields(), {
    material: "",
    labor: "0",
    packaging: "0",
    shipping: "",
  });
});
