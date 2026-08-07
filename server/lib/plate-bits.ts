/**
 * Parts linked to an attached plate (print_file_records row).
 * Operator drops STLs that were on that CTB; CTB itself has no part names.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  printFileRecords,
  printPlateBits,
  type PrintPlateBit,
  type PrintPlateBitStatus,
} from "../../shared/schema";
import { getDb } from "./order-links";
import {
  releaseOrderPartFromDeletedPlateBit,
  syncOrderPartFromPlateBitStatus,
  syncOrderPartsFromPlateBits,
} from "./order-parts";

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

export function listBitsForRecord(printFileRecordId: number): PrintPlateBit[] {
  return getDb()
    .select()
    .from(printPlateBits)
    .where(eq(printPlateBits.printFileRecordId, printFileRecordId))
    .orderBy(asc(printPlateBits.fileName), asc(printPlateBits.id))
    .all();
}

export function listBitsForRecords(
  recordIds: number[],
): Map<number, PrintPlateBit[]> {
  const map = new Map<number, PrintPlateBit[]>();
  if (recordIds.length === 0) return map;
  const rows = getDb()
    .select()
    .from(printPlateBits)
    .where(inArray(printPlateBits.printFileRecordId, recordIds))
    .orderBy(asc(printPlateBits.fileName), asc(printPlateBits.id))
    .all();
  for (const row of rows) {
    const list = map.get(row.printFileRecordId) ?? [];
    list.push(row);
    map.set(row.printFileRecordId, list);
  }
  return map;
}

export function summarizeBits(bits: PrintPlateBit[]): {
  total: number;
  onPlate: number;
  good: number;
  reprint: number;
} {
  return {
    total: bits.length,
    onPlate: bits.filter((bit) => bit.status === "on_plate").length,
    good: bits.filter((bit) => bit.status === "good").length,
    reprint: bits.filter((bit) => bit.status === "reprint").length,
  };
}

export function addBitsToRecord(
  printFileRecordId: number,
  fileNames: string[],
): { ok: true; bits: PrintPlateBit[]; added: number } | { ok: false; error: string } {
  if (!Number.isInteger(printFileRecordId) || printFileRecordId < 1) {
    return { ok: false, error: "Choose a valid plate." };
  }
  const record = getDb()
    .select({
      id: printFileRecords.id,
      hubspotDealId: printFileRecords.hubspotDealId,
      hubspotDealName: printFileRecords.hubspotDealName,
    })
    .from(printFileRecords)
    .where(eq(printFileRecords.id, printFileRecordId))
    .get();
  if (!record) return { ok: false, error: "That plate was not found." };

  const existingKeys = new Set(
    listBitsForRecord(printFileRecordId).map((bit) => bit.fileName.toLowerCase()),
  );
  const droppedKeys = new Set<string>();
  const stamp = nowIso();
  let added = 0;

  for (const raw of fileNames) {
    const fileName = normalizeStlFileName(raw);
    if (!fileName) continue;
    const key = fileName.toLowerCase();
    droppedKeys.add(key);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    getDb()
      .insert(printPlateBits)
      .values({
        printFileRecordId,
        fileName,
        label: labelFromFileName(fileName),
        status: "on_plate",
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
    added += 1;
  }

  if (added === 0 && fileNames.length > 0) {
    const hadStl = fileNames.some((name) => Boolean(normalizeStlFileName(name)));
    if (!hadStl) return { ok: false, error: "Drop .stl files (part files), not the CTB." };
  }

  const bits = listBitsForRecord(printFileRecordId);
  if (droppedKeys.size > 0) {
    syncOrderPartsFromPlateBits({
      hubspotDealId: record.hubspotDealId,
      hubspotDealName: record.hubspotDealName,
      printFileRecordId,
      bits: bits.filter((bit) => droppedKeys.has(bit.fileName.toLowerCase())),
    });
  }

  return { ok: true, bits, added };
}

export function updateBitStatus(
  printFileRecordId: number,
  bitId: number,
  status: PrintPlateBitStatus,
): { ok: true; bit: PrintPlateBit } | { ok: false; error: string } {
  const existing = getDb()
    .select()
    .from(printPlateBits)
    .where(
      and(eq(printPlateBits.id, bitId), eq(printPlateBits.printFileRecordId, printFileRecordId)),
    )
    .get();
  if (!existing) return { ok: false, error: "That part was not found on this plate." };

  const updated = getDb()
    .update(printPlateBits)
    .set({ status, updatedAt: nowIso() })
    .where(eq(printPlateBits.id, bitId))
    .returning()
    .get();

  syncOrderPartFromPlateBitStatus({ printFileRecordId, bit: updated });

  return { ok: true, bit: updated };
}

export function deleteBit(
  printFileRecordId: number,
  bitId: number,
): { ok: true; deleted: boolean } | { ok: false; error: string } {
  const existing = getDb()
    .select()
    .from(printPlateBits)
    .where(
      and(eq(printPlateBits.id, bitId), eq(printPlateBits.printFileRecordId, printFileRecordId)),
    )
    .get();
  if (!existing) return { ok: true, deleted: false };

  releaseOrderPartFromDeletedPlateBit(bitId);

  const result = getDb()
    .delete(printPlateBits)
    .where(
      and(eq(printPlateBits.id, bitId), eq(printPlateBits.printFileRecordId, printFileRecordId)),
    )
    .run();
  return { ok: true, deleted: Number(result.changes ?? 0) > 0 };
}
