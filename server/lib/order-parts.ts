/**
 * Master parts checklist per HubSpot Print Order.
 * Import the full kit once; plate STL drops move parts needed → on_plate → good/reprint.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import {
  orderParts,
  printFileRecords,
  type OrderPart,
  type OrderPartStatus,
  type PrintPlateBit,
} from "../../shared/schema";
import { getDb } from "./order-links";

function nowIso(): string {
  return new Date().toISOString();
}

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function labelFromFileName(fileName: string): string {
  return fileName.replace(/\.stl$/i, "").trim() || fileName;
}

function normalizeStlFileName(raw: string): string | null {
  const name = baseName(raw).trim();
  if (!name || !/\.stl$/i.test(name)) return null;
  return name;
}

export type OrderPartSummary = {
  hubspotDealId: string;
  hubspotDealName: string;
  total: number;
  needed: number;
  onPlate: number;
  good: number;
  reprint: number;
  remaining: number;
};

export function summarizeOrderParts(parts: OrderPart[]): Omit<OrderPartSummary, "hubspotDealId" | "hubspotDealName"> {
  const needed = parts.filter((part) => part.status === "needed").length;
  const onPlate = parts.filter((part) => part.status === "on_plate").length;
  const good = parts.filter((part) => part.status === "good").length;
  const reprint = parts.filter((part) => part.status === "reprint").length;
  return {
    total: parts.length,
    needed,
    onPlate,
    good,
    reprint,
    remaining: needed + reprint,
  };
}

export function listOrderParts(dealId: string): OrderPart[] {
  const id = dealId.trim();
  if (!id) return [];
  return getDb()
    .select()
    .from(orderParts)
    .where(eq(orderParts.hubspotDealId, id))
    .orderBy(asc(orderParts.fileName), asc(orderParts.id))
    .all();
}

export function getOrderPartsView(dealId: string): {
  dealId: string;
  dealName: string;
  parts: OrderPart[];
  summary: ReturnType<typeof summarizeOrderParts>;
} {
  const parts = listOrderParts(dealId);
  const dealName = parts[0]?.hubspotDealName || "";
  return {
    dealId: dealId.trim(),
    dealName,
    parts,
    summary: summarizeOrderParts(parts),
  };
}

export function listOrderPartSummaries(limit = 300): OrderPartSummary[] {
  const rows = getDb()
    .select()
    .from(orderParts)
    .orderBy(desc(orderParts.updatedAt))
    .limit(Math.max(1, Math.min(limit * 20, 10_000)))
    .all();

  const byDeal = new Map<string, OrderPart[]>();
  for (const row of rows) {
    const list = byDeal.get(row.hubspotDealId) ?? [];
    list.push(row);
    byDeal.set(row.hubspotDealId, list);
  }

  const out: OrderPartSummary[] = [];
  for (const [hubspotDealId, parts] of Array.from(byDeal.entries())) {
    out.push({
      hubspotDealId,
      hubspotDealName: parts[0]?.hubspotDealName || "",
      ...summarizeOrderParts(parts),
    });
  }
  return out
    .sort((a, b) => a.hubspotDealName.localeCompare(b.hubspotDealName))
    .slice(0, Math.max(1, Math.min(limit, 500)));
}

export function importOrderParts(
  dealId: string,
  input: { fileNames: string[]; dealName?: string },
): { ok: true; parts: OrderPart[]; added: number; summary: ReturnType<typeof summarizeOrderParts> } | { ok: false; error: string } {
  const id = dealId.trim();
  if (!/^[0-9]{1,20}$/.test(id)) return { ok: false, error: "Select a valid Print Order." };

  const dealName = (input.dealName || "").trim() || `Print Order ${id}`;
  const existing = new Map(
    listOrderParts(id).map((part) => [part.fileName.toLowerCase(), part] as const),
  );
  const stamp = nowIso();
  let added = 0;

  for (const raw of input.fileNames) {
    const fileName = normalizeStlFileName(raw);
    if (!fileName) continue;
    const key = fileName.toLowerCase();
    if (existing.has(key)) continue;
    getDb()
      .insert(orderParts)
      .values({
        hubspotDealId: id,
        hubspotDealName: dealName,
        fileName,
        label: labelFromFileName(fileName),
        status: "needed",
        printFileRecordId: null,
        printPlateBitId: null,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
    existing.set(key, null as unknown as OrderPart);
    added += 1;
  }

  if (added === 0 && input.fileNames.length > 0) {
    const hadStl = input.fileNames.some((name) => Boolean(normalizeStlFileName(name)));
    if (!hadStl) return { ok: false, error: "Drop .stl files (or a zip of them) to build the parts list." };
  }

  // Keep deal name fresh on existing rows when provided
  if (input.dealName?.trim()) {
    getDb()
      .update(orderParts)
      .set({ hubspotDealName: dealName, updatedAt: stamp })
      .where(eq(orderParts.hubspotDealId, id))
      .run();
  }

  const parts = listOrderParts(id);
  return { ok: true, parts, added, summary: summarizeOrderParts(parts) };
}

export function updateOrderPartStatus(
  dealId: string,
  partId: number,
  status: OrderPartStatus,
): { ok: true; part: OrderPart; parts: OrderPart[]; summary: ReturnType<typeof summarizeOrderParts> } | { ok: false; error: string } {
  const id = dealId.trim();
  const existing = getDb()
    .select()
    .from(orderParts)
    .where(and(eq(orderParts.id, partId), eq(orderParts.hubspotDealId, id)))
    .get();
  if (!existing) return { ok: false, error: "That part was not found on this order." };

  const patch: Partial<OrderPart> = {
    status,
    updatedAt: nowIso(),
  };
  if (status === "needed" || status === "reprint") {
    patch.printFileRecordId = null;
    patch.printPlateBitId = null;
  }

  const updated = getDb()
    .update(orderParts)
    .set(patch)
    .where(eq(orderParts.id, partId))
    .returning()
    .get();

  const parts = listOrderParts(id);
  return { ok: true, part: updated, parts, summary: summarizeOrderParts(parts) };
}

export function deleteOrderPart(
  dealId: string,
  partId: number,
): { ok: true; deleted: boolean; parts: OrderPart[]; summary: ReturnType<typeof summarizeOrderParts> } | { ok: false; error: string } {
  const id = dealId.trim();
  const result = getDb()
    .delete(orderParts)
    .where(and(eq(orderParts.id, partId), eq(orderParts.hubspotDealId, id)))
    .run();
  const parts = listOrderParts(id);
  return {
    ok: true,
    deleted: Number(result.changes ?? 0) > 0,
    parts,
    summary: summarizeOrderParts(parts),
  };
}

export function clearOrderParts(dealId: string): number {
  const result = getDb().delete(orderParts).where(eq(orderParts.hubspotDealId, dealId.trim())).run();
  return Number(result.changes ?? 0);
}

/**
 * When STLs are dropped onto a plate, mark matching order parts on_plate
 * (or create them if the order list was not imported yet).
 */
export function syncOrderPartsFromPlateBits(input: {
  hubspotDealId: string;
  hubspotDealName?: string;
  printFileRecordId: number;
  bits: PrintPlateBit[];
}): void {
  const dealId = input.hubspotDealId.trim();
  if (!dealId || input.bits.length === 0) return;
  const dealName =
    (input.hubspotDealName || "").trim() ||
    listOrderParts(dealId)[0]?.hubspotDealName ||
    `Print Order ${dealId}`;
  const stamp = nowIso();
  const existing = listOrderParts(dealId);
  const byName = new Map(existing.map((part) => [part.fileName.toLowerCase(), part]));

  for (const bit of input.bits) {
    const key = bit.fileName.toLowerCase();
    const current = byName.get(key);
    if (!current) {
      getDb()
        .insert(orderParts)
        .values({
          hubspotDealId: dealId,
          hubspotDealName: dealName,
          fileName: bit.fileName,
          label: bit.label || labelFromFileName(bit.fileName),
          status: bit.status === "good" ? "good" : bit.status === "reprint" ? "reprint" : "on_plate",
          printFileRecordId: input.printFileRecordId,
          printPlateBitId: bit.id,
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run();
      continue;
    }

    // Don't pull a finished good part back unless plate says reprint
    if (current.status === "good" && bit.status !== "reprint" && bit.status !== "on_plate") {
      continue;
    }
    if (current.status === "good" && bit.status === "on_plate") {
      // Re-plating a previously good part (rare) — leave good
      continue;
    }

    const nextStatus: OrderPartStatus =
      bit.status === "good" ? "good" : bit.status === "reprint" ? "reprint" : "on_plate";

    getDb()
      .update(orderParts)
      .set({
        status: nextStatus,
        printFileRecordId: nextStatus === "reprint" ? null : input.printFileRecordId,
        printPlateBitId: nextStatus === "reprint" ? null : bit.id,
        hubspotDealName: dealName,
        updatedAt: stamp,
      })
      .where(eq(orderParts.id, current.id))
      .run();
  }
}

export function syncOrderPartFromPlateBitStatus(input: {
  printFileRecordId: number;
  bit: PrintPlateBit;
}): void {
  const record = getDb()
    .select({
      hubspotDealId: printFileRecords.hubspotDealId,
      hubspotDealName: printFileRecords.hubspotDealName,
    })
    .from(printFileRecords)
    .where(eq(printFileRecords.id, input.printFileRecordId))
    .get();
  if (!record) return;

  const stamp = nowIso();
  const linked = getDb()
    .select()
    .from(orderParts)
    .where(eq(orderParts.printPlateBitId, input.bit.id))
    .get();

  const byName =
    linked ||
    listOrderParts(record.hubspotDealId).find(
      (part) => part.fileName.toLowerCase() === input.bit.fileName.toLowerCase(),
    );

  if (!byName) {
    syncOrderPartsFromPlateBits({
      hubspotDealId: record.hubspotDealId,
      hubspotDealName: record.hubspotDealName,
      printFileRecordId: input.printFileRecordId,
      bits: [input.bit],
    });
    return;
  }

  const nextStatus: OrderPartStatus =
    input.bit.status === "good"
      ? "good"
      : input.bit.status === "reprint"
        ? "reprint"
        : "on_plate";

  getDb()
    .update(orderParts)
    .set({
      status: nextStatus,
      printFileRecordId: nextStatus === "reprint" ? null : input.printFileRecordId,
      printPlateBitId: nextStatus === "reprint" ? null : input.bit.id,
      updatedAt: stamp,
    })
    .where(eq(orderParts.id, byName.id))
    .run();
}

export function releaseOrderPartFromDeletedPlateBit(bitId: number): void {
  const linked = getDb().select().from(orderParts).where(eq(orderParts.printPlateBitId, bitId)).get();
  if (!linked) return;
  if (linked.status === "good") {
    getDb()
      .update(orderParts)
      .set({ printPlateBitId: null, printFileRecordId: null, updatedAt: nowIso() })
      .where(eq(orderParts.id, linked.id))
      .run();
    return;
  }
  getDb()
    .update(orderParts)
    .set({
      status: linked.status === "reprint" ? "reprint" : "needed",
      printPlateBitId: null,
      printFileRecordId: null,
      updatedAt: nowIso(),
    })
    .where(eq(orderParts.id, linked.id))
    .run();
}
