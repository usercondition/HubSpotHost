import test from "node:test";
import assert from "node:assert/strict";
import {
  dealCostsCompleteFromFields,
  dealCostsIncomplete,
} from "../shared/deal-costs";

test("print deals only require material and shipping for cost completeness", () => {
  assert.equal(
    dealCostsIncomplete(
      {
        print_material_cost: "12.50",
        print_labor_cost: "",
        print_packaging_cost: "",
        print_actual_shipping_cost: "5.42",
      },
      { requiresPlates: true },
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
      { requiresPlates: true },
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
      { requiresPlates: true },
    ),
    true,
  );
});

test("shipping charge lines only require actual shipping cost", () => {
  assert.equal(
    dealCostsIncomplete(
      {
        print_material_cost: "",
        print_labor_cost: "",
        print_packaging_cost: "",
        print_actual_shipping_cost: "",
      },
      { requiresPlates: false },
    ),
    true,
  );
  assert.equal(
    dealCostsIncomplete(
      {
        print_material_cost: "",
        print_actual_shipping_cost: "8",
      },
      { requiresPlates: false },
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
