import test from "node:test";
import assert from "node:assert/strict";
import { OPS_APP, SHOP_BRAND } from "../shared/brand";

test("customer shop name is Mercado Prints, not the floor app", () => {
  assert.equal(SHOP_BRAND.shopName, "Mercado Prints");
  assert.equal(OPS_APP.name, "Print Ops");
  assert.notEqual(SHOP_BRAND.shopName, OPS_APP.name);
  assert.match(SHOP_BRAND.legalName, /d\/b\/a Mercado Prints/);
  assert.match(SHOP_BRAND.locationLine, /Kensington/);
});
