/**
 * Proof that a client confirmed their name and shipping address, or that the shop entered it.
 * The local row and the Print Ops update log always record the event.
 * The HubSpot deal property is written only when it is still empty.
 */
import { getConfig, resolveWriteDecision } from "./config";
import { ensurePrintFileDealProperties, hubspotRequest } from "./hubspot";
import { getSqlite } from "./order-links";
import { appendOrderUpdate } from "./order-updates";
import {
  PRINT_CLIENT_CONFIRMED_ADDRESS_PROPERTY,
  formatAddressEntryLabel,
  formatClientConfirmedProperty,
  type AddressAckSource,
  type AddressAcknowledgment,
} from "../../shared/address-ack";

function ensureTable(): void {
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS address_acknowledgments (
      order_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL,
      snapshot TEXT NOT NULL DEFAULT '',
      text_version TEXT NOT NULL DEFAULT '',
      form_source TEXT NOT NULL DEFAULT ''
    );
  `);
}

function readRow(orderKey: string): AddressAcknowledgment | null {
  ensureTable();
  const row = getSqlite()
    .prepare(
      `SELECT order_key, source, acknowledged_at, snapshot, text_version, form_source
       FROM address_acknowledgments WHERE order_key = ?`,
    )
    .get(orderKey) as
    | {
        order_key: string;
        source: string;
        acknowledged_at: string;
        snapshot: string;
        text_version: string;
        form_source: string;
      }
    | undefined;
  if (!row) return null;
  if (row.source !== "client" && row.source !== "shop") return null;
  return {
    orderKey: row.order_key,
    source: row.source,
    acknowledgedAt: row.acknowledged_at,
    snapshot: row.snapshot,
    textVersion: row.text_version,
    formSource: row.form_source,
  };
}

export function readAddressAcknowledgment(orderKey: string): AddressAcknowledgment | null {
  return readRow(orderKey);
}

export function addressEntryLabelFor(orderKey: string): string | null {
  return formatAddressEntryLabel(readRow(orderKey));
}

export function saveAddressAcknowledgment(input: AddressAcknowledgment): void {
  ensureTable();
  getSqlite()
    .prepare(
      `INSERT INTO address_acknowledgments (order_key, source, acknowledged_at, snapshot, text_version, form_source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_key) DO UPDATE SET
         source = excluded.source,
         acknowledged_at = excluded.acknowledged_at,
         snapshot = excluded.snapshot,
         text_version = excluded.text_version,
         form_source = excluded.form_source`,
    )
    .run(
      input.orderKey,
      input.source,
      input.acknowledgedAt,
      input.snapshot,
      input.textVersion,
      input.formSource,
    );
}

/**
 * Create the deal property when it is missing, then PATCH only when the current value is blank.
 * An existing value is left alone.
 */
export async function writeClientConfirmedAddressIfEmpty(
  dealId: string,
  value: string,
): Promise<"skipped" | "kept" | "written"> {
  const decision = resolveWriteDecision(getConfig(), true);
  if (!decision.write) return "skipped";
  const current = await hubspotRequest(
    `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${PRINT_CLIENT_CONFIRMED_ADDRESS_PROPERTY}`,
    { method: "GET" },
  );
  const existing = String(current?.properties?.[PRINT_CLIENT_CONFIRMED_ADDRESS_PROPERTY] ?? "").trim();
  if (existing) return "kept";
  await ensurePrintFileDealProperties();
  await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: { [PRINT_CLIENT_CONFIRMED_ADDRESS_PROPERTY]: value.slice(0, 6000) },
    }),
  });
  return "written";
}

/** Copy a client-form acknowledgment onto each new deal. A HubSpot failure does not undo the local proof. */
export async function publishClientAddressAcknowledgments(
  dealIds: string[],
  input: {
    acknowledgedAt: string;
    snapshot: string;
    textVersion: string;
    formSource: string;
  },
): Promise<void> {
  const propertyValue = formatClientConfirmedProperty(input);
  for (const dealId of dealIds) {
    const orderKey = `deal:${dealId}`;
    saveAddressAcknowledgment({
      orderKey,
      source: "client" satisfies AddressAckSource,
      acknowledgedAt: input.acknowledgedAt,
      snapshot: input.snapshot,
      textVersion: input.textVersion,
      formSource: input.formSource,
    });
    appendOrderUpdate({
      orderKey,
      text: `Client confirmed name and address.\n${input.snapshot}\ncheckbox ${input.textVersion} · form ${input.formSource}`,
      source: "system",
      author: "Client",
    });
    try {
      await writeClientConfirmedAddressIfEmpty(dealId, propertyValue);
    } catch {
      // The intake row, the local acknowledgment, and the update log already hold the proof.
    }
  }
}

/** Paste-to-fill and Fix in HubSpot. Replaces the drawer line with "Entered by shop" and does not touch the client property. */
export function recordShopAddressEntry(input: {
  orderKey: string;
  formSource: string;
  snapshot: string;
  sourceKind: "manual" | "system";
}): void {
  const acknowledgedAt = new Date().toISOString();
  saveAddressAcknowledgment({
    orderKey: input.orderKey,
    source: "shop",
    acknowledgedAt,
    snapshot: input.snapshot,
    textVersion: "",
    formSource: input.formSource,
  });
  appendOrderUpdate({
    orderKey: input.orderKey,
    text: `Entered by shop.\n${input.snapshot}`,
    source: input.sourceKind,
    author: "Miguel",
  });
}
