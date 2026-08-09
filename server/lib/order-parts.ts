/**
 * Master parts checklist per HubSpot Print Order.
 * Multiple products on one order are separated by `itemGroup`.
 * Plate STL drops move parts needed → on_plate → good/reprint.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import {
  orderParts,
  printFileRecords,
  type ImportOrderPartsInput,
  type OrderPart,
  type OrderPartStatus,
  type PrintPlateBit,
} from "../../shared/schema";
import { labelFromStlFileName, normalizeStlFileName } from "../../shared/stl-names";
import { getDb } from "./order-links";

export const DEFAULT_ITEM_GROUP = "Kit";

function nowIso(): string {
  return new Date().toISOString();
}

function cleanSegment(segment: string): string {
  return segment.replace(/\.zip$/i, "").replace(/@.*$/, "").trim();
}

export function normalizeItemGroup(raw: string | null | undefined): string {
  const value = (raw || "").trim();
  return value || DEFAULT_ITEM_GROUP;
}

/**
 * Infer product item groups from paths/zips.
 * Multiple top-level roots or zip names → separate items.
 * A single shared tree stays one item (does not split Head/Legs part folders).
 */
export function inferItemGroupFromPath(
  relativePath: string,
  archivePath?: string,
): string {
  const pathParts = relativePath
    .split(/[/\\]/)
    .map(cleanSegment)
    .filter(Boolean);
  // Drop the filename
  if (pathParts.length > 0 && /\.stl$/i.test(pathParts[pathParts.length - 1] || "")) {
    pathParts.pop();
  }

  if (archivePath) {
    const archiveParts = archivePath
      .split(/[/\\]/)
      .map(cleanSegment)
      .filter(Boolean);
    const zipName = archiveParts[archiveParts.length - 1] || "";
    if (zipName) return zipName;
  }

  if (pathParts.length >= 1) return pathParts[0]!;
  return "";
}

export function resolveImportItemGroups(
  entries: Array<{ fileName: string; relativePath?: string; itemGroup?: string; archivePath?: string }>,
  defaultItemGroup?: string,
): Array<{ fileName: string; itemGroup: string }> {
  if (defaultItemGroup?.trim()) {
    const forced = normalizeItemGroup(defaultItemGroup);
    return entries
      .map((entry) => {
        const fileName = normalizeStlFileName(entry.fileName || entry.relativePath || "");
        if (!fileName) return null;
        return { fileName, itemGroup: forced };
      })
      .filter((row): row is { fileName: string; itemGroup: string } => Boolean(row));
  }

  const prepared = entries
    .map((entry) => {
      const fileName = normalizeStlFileName(entry.fileName || entry.relativePath || "");
      if (!fileName) return null;
      const explicit = entry.itemGroup?.trim();
      const inferred = inferItemGroupFromPath(entry.relativePath || fileName, entry.archivePath);
      return { fileName, explicit, inferred };
    })
    .filter((row): row is { fileName: string; explicit: string | undefined; inferred: string } => Boolean(row));

  const inferredRoots = new Set(prepared.map((row) => row.inferred).filter(Boolean));
  const useInferred = inferredRoots.size >= 2;

  return prepared.map((row) => ({
    fileName: row.fileName,
    itemGroup: normalizeItemGroup(
      row.explicit || (useInferred ? row.inferred : row.inferred || DEFAULT_ITEM_GROUP),
    ),
  }));
}

export type OrderPartItemGroupSummary = {
  itemGroup: string;
  total: number;
  needed: number;
  onPlate: number;
  good: number;
  reprint: number;
  remaining: number;
};

export type OrderPartSummary = {
  hubspotDealId: string;
  hubspotDealName: string;
  total: number;
  needed: number;
  onPlate: number;
  good: number;
  reprint: number;
  remaining: number;
  itemGroups: OrderPartItemGroupSummary[];
};

export function summarizeOrderParts(
  parts: OrderPart[],
): Omit<OrderPartSummary, "hubspotDealId" | "hubspotDealName"> {
  const needed = parts.filter((part) => part.status === "needed").length;
  const onPlate = parts.filter((part) => part.status === "on_plate").length;
  const good = parts.filter((part) => part.status === "good").length;
  const reprint = parts.filter((part) => part.status === "reprint").length;

  const byGroup = new Map<string, OrderPart[]>();
  for (const part of parts) {
    const key = normalizeItemGroup(part.itemGroup);
    const list = byGroup.get(key) ?? [];
    list.push(part);
    byGroup.set(key, list);
  }

  const itemGroups: OrderPartItemGroupSummary[] = Array.from(byGroup.entries())
    .map(([itemGroup, groupParts]) => {
      const gNeeded = groupParts.filter((part) => part.status === "needed").length;
      const gOnPlate = groupParts.filter((part) => part.status === "on_plate").length;
      const gGood = groupParts.filter((part) => part.status === "good").length;
      const gReprint = groupParts.filter((part) => part.status === "reprint").length;
      return {
        itemGroup,
        total: groupParts.length,
        needed: gNeeded,
        onPlate: gOnPlate,
        good: gGood,
        reprint: gReprint,
        remaining: gNeeded + gReprint,
      };
    })
    .sort((a, b) => a.itemGroup.localeCompare(b.itemGroup));

  return {
    total: parts.length,
    needed,
    onPlate,
    good,
    reprint,
    remaining: needed + reprint,
    itemGroups,
  };
}

export function listOrderParts(dealId: string): OrderPart[] {
  const id = dealId.trim();
  if (!id) return [];
  return getDb()
    .select()
    .from(orderParts)
    .where(eq(orderParts.hubspotDealId, id))
    .orderBy(asc(orderParts.itemGroup), asc(orderParts.fileName), asc(orderParts.id))
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

function partKey(itemGroup: string, fileName: string): string {
  return `${normalizeItemGroup(itemGroup).toLowerCase()}::${fileName.toLowerCase()}`;
}

export function importOrderParts(
  dealId: string,
  input: ImportOrderPartsInput,
): { ok: true; parts: OrderPart[]; added: number; summary: ReturnType<typeof summarizeOrderParts> } | { ok: false; error: string } {
  const id = dealId.trim();
  if (!/^[0-9]{1,20}$/.test(id)) return { ok: false, error: "Select a valid Print Order." };

  const dealName = (input.dealName || "").trim() || `Print Order ${id}`;
  const rawEntries = [
    ...(input.parts || []),
    ...(input.fileNames || []).map((fileName) => ({ fileName })),
  ];
  const resolved = resolveImportItemGroups(rawEntries, input.defaultItemGroup);

  const existing = new Map(
    listOrderParts(id).map((part) => [partKey(part.itemGroup, part.fileName), part] as const),
  );
  const stamp = nowIso();
  let added = 0;

  for (const entry of resolved) {
    const key = partKey(entry.itemGroup, entry.fileName);
    if (existing.has(key)) continue;
    getDb()
      .insert(orderParts)
      .values({
        hubspotDealId: id,
        hubspotDealName: dealName,
        itemGroup: entry.itemGroup,
        fileName: entry.fileName,
        label: labelFromStlFileName(entry.fileName),
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

  if (added === 0 && rawEntries.length > 0) {
    const hadStl = rawEntries.some((entry) => Boolean(normalizeStlFileName(entry.fileName)));
    if (!hadStl) return { ok: false, error: "Drop .stl files (or a zip of them) to build the parts list." };
  }

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

function pickOrderPartForPlateBit(
  existing: OrderPart[],
  fileName: string,
  itemHint?: string,
): OrderPart | undefined {
  const matches = existing.filter((part) => part.fileName.toLowerCase() === fileName.toLowerCase());
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  const hint = normalizeItemGroup(itemHint).toLowerCase();
  const byHint = matches.find((part) => normalizeItemGroup(part.itemGroup).toLowerCase() === hint);
  if (byHint) return byHint;

  // Prefer parts that still need work when the name collides across items
  return (
    matches.find((part) => part.status === "needed" || part.status === "reprint") ||
    matches.find((part) => part.status === "on_plate") ||
    matches[0]
  );
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
  /** Optional per-filename item hints from folder/zip path. */
  itemHints?: Record<string, string>;
}): void {
  const dealId = input.hubspotDealId.trim();
  if (!dealId || input.bits.length === 0) return;
  const dealName =
    (input.hubspotDealName || "").trim() ||
    listOrderParts(dealId)[0]?.hubspotDealName ||
    `Print Order ${dealId}`;
  const stamp = nowIso();
  const existing = listOrderParts(dealId);
  const existingGroups = new Set(existing.map((part) => normalizeItemGroup(part.itemGroup)));

  for (const bit of input.bits) {
    const hint = input.itemHints?.[bit.fileName.toLowerCase()];
    const current = pickOrderPartForPlateBit(existing, bit.fileName, hint);
    if (!current) {
      const itemGroup = normalizeItemGroup(
        hint || (existingGroups.size === 1 ? Array.from(existingGroups)[0] : DEFAULT_ITEM_GROUP),
      );
      getDb()
        .insert(orderParts)
        .values({
          hubspotDealId: dealId,
          hubspotDealName: dealName,
          itemGroup,
          fileName: bit.fileName,
          label: bit.label || labelFromStlFileName(bit.fileName),
          status: bit.status === "good" ? "good" : bit.status === "reprint" ? "reprint" : "on_plate",
          printFileRecordId: input.printFileRecordId,
          printPlateBitId: bit.id,
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run();
      continue;
    }

    if (current.status === "good" && bit.status === "on_plate") continue;

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
    linked || pickOrderPartForPlateBit(listOrderParts(record.hubspotDealId), input.bit.fileName);

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
