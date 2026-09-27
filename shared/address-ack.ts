/**
 * Client acknowledgment that the name and shipping address on the confirm step
 * are the ones that will be used on the label and the order.
 */
import { formatLabelAddress } from "./address-capture";
import type { ShipAddressFields } from "./ship-address";

export const CLIENT_ADDRESS_ACK_VERSION = "v1";
export const CLIENT_ADDRESS_ACK_FORM = "client-order";
export const CLIENT_ADDRESS_ACK_TEXT =
  "I confirm my name and shipping address above are correct. Orders ship to exactly this address, and I'm responsible for any errors in what I entered.";

export const SHOP_ADDRESS_FORM_PASTE = "paste";
export const SHOP_ADDRESS_FORM_CLEANUP = "hubspot-cleanup";

export const PRINT_CLIENT_CONFIRMED_ADDRESS_PROPERTY = "print_client_confirmed_address";

export type AddressAckSource = "client" | "shop";

export type AddressAcknowledgment = {
  orderKey: string;
  source: AddressAckSource;
  acknowledgedAt: string;
  snapshot: string;
  textVersion: string;
  formSource: string;
};

/** Exact name, contact, and label address the buyer confirmed. Built on the server. */
export function buildAddressAckSnapshot(input: {
  fullName: string;
  email: string;
  phone: string;
  address: ShipAddressFields;
}): string {
  const lines = [input.fullName.trim()];
  const email = input.email.trim();
  const phone = input.phone.trim();
  if (email) lines.push(email);
  if (phone) lines.push(phone);
  lines.push(formatLabelAddress(input.address));
  return lines.join("\n");
}

/** Value stored on the HubSpot deal when that property is still empty. */
export function formatClientConfirmedProperty(input: {
  acknowledgedAt: string;
  snapshot: string;
  textVersion: string;
  formSource: string;
}): string {
  return [input.acknowledgedAt, input.snapshot, `checkbox ${input.textVersion}`, `form ${input.formSource}`].join("\n");
}

export function formatAckDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  })
    .format(date)
    .replace(/[\u202f\u00a0]/g, " ");
}

/** Small line for the order drawer and the ship-to block. Null when nobody recorded an entry. */
export function formatAddressEntryLabel(
  row: Pick<AddressAcknowledgment, "source" | "acknowledgedAt"> | null | undefined,
): string | null {
  if (!row) return null;
  if (row.source === "shop") return "Entered by shop";
  const date = formatAckDate(row.acknowledgedAt);
  return date ? `Client confirmed name and address on ${date}` : "Client confirmed name and address";
}
