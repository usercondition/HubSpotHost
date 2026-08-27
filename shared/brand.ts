/**
 * Customer-facing shop vs the shop-floor app.
 *
 * Mercado Prints is what buyers see (order form, packing slip, ship email).
 * Print Ops is the internal floor tool. Do not mix them on customer surfaces.
 *
 * Trade name today: Miguel Mercado d/b/a Mercado Prints (Kensington, San Diego).
 * File a San Diego County FBN and a CA LLC later if you want the name on
 * checks / liability separate from the personal name.
 */
export const SHOP_BRAND = {
  shopName: "Mercado Prints",
  tagline: "from the studio bench",
  locationLine: "Kensington, San Diego",
  fromDisplayName: "Miguel at Mercado Prints",
  supportLine: "Questions, photos, or praise? Just reply — a human reads these.",
  accentHex: "#3F5D4A",
  legalName: "Miguel Mercado d/b/a Mercado Prints",
} as const;

/** Internal shop-floor app — never the customer brand. */
export const OPS_APP = {
  name: "Print Ops",
} as const;

export type ShopBrand = typeof SHOP_BRAND;
