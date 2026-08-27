/**
 * Local tracking for CTB production metadata.
 *
 * A raw slicer file is parsed in memory and discarded. The short-lived
 * analysis lets the owner choose the correct deal before attaching it. Only
 * the extracted values and source file fingerprint are retained in SQLite.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { desc, eq } from "drizzle-orm";
import {
  printFileAnalyses,
  printFileRecords,
  type PrintFileAnalysis,
  type PrintFileDealBoard,
  type PrintFileMetrics,
  type PrintFileOrderSummary,
  type PrintFileRecord,
} from "../../shared/schema";
import { getDb } from "./order-links";
import { CtbParseError, parseCtbFile, parseCtbFileFromPath, parseCtbFileFromPrefix } from "./ctb";
import { UltxParseError, parseUltxFile, parseUltxFileFromPath } from "./ultx";
import { enrichPrintFileMetricsWithResinCost } from "./resin-pricing";

export { CtbParseError, UltxParseError };

function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

export function isSupportedSliceFileName(fileName: string): boolean {
  const ext = extensionOf(fileName);
  return ext === "ctb" || ext === "ultx";
}

export const PRINT_FILE_ANALYSIS_TTL_MINUTES = 20;

function nowIso(): string {
  return new Date().toISOString();
}

function expiresAt(): string {
  return new Date(Date.now() + PRINT_FILE_ANALYSIS_TTL_MINUTES * 60_000).toISOString();
}

function decimal(value: number | null): string | null {
  return value === null ? null : String(value);
}

function parseMetrics(value: string): PrintFileMetrics | null {
  try {
    const parsed = JSON.parse(value) as Partial<PrintFileMetrics>;
    if (
      (parsed.format !== "CTB" && parsed.format !== "ULTX") ||
      typeof parsed.fileName !== "string" ||
      typeof parsed.fileSizeBytes !== "number" ||
      typeof parsed.sha256 !== "string"
    ) {
      return null;
    }
    return parsed as PrintFileMetrics;
  } catch {
    return null;
  }
}

export interface StagePrintFileOptions {
  /** Blueprint Slice.log text — used for sealed HeyGears .ultx time/resin recovery. */
  sliceLogText?: string | null;
}

function parseSliceBuffer(
  fileName: string,
  buffer: Buffer,
  options?: StagePrintFileOptions,
): PrintFileMetrics {
  const ext = extensionOf(fileName);
  if (ext === "ultx") return parseUltxFile(fileName, buffer, { sliceLogText: options?.sliceLogText });
  if (ext === "ctb") return parseCtbFile(fileName, buffer);
  throw new CtbParseError("Only Chitubox .ctb and HeyGears .ultx slice files can be analyzed here");
}

function parseSlicePath(
  fileName: string,
  filePath: string,
  options?: StagePrintFileOptions,
): PrintFileMetrics {
  const ext = extensionOf(fileName);
  if (ext === "ultx") {
    return parseUltxFileFromPath(fileName, filePath, { sliceLogText: options?.sliceLogText });
  }
  if (ext === "ctb") return parseCtbFileFromPath(fileName, filePath);
  throw new CtbParseError("Only Chitubox .ctb and HeyGears .ultx slice files can be analyzed here");
}

export function stagePrintFile(
  fileName: string,
  buffer: Buffer,
  options?: StagePrintFileOptions,
): {
  analysisId: string;
  metrics: PrintFileMetrics;
  expiresAt: string;
} {
  return stageParsedPrintFile(
    fileName,
    enrichPrintFileMetricsWithResinCost(parseSliceBuffer(fileName, buffer, options)),
  );
}

/** Stage a slice file uploaded to a temporary disk path (preferred for large plates). */
export function stagePrintFileFromPath(
  fileName: string,
  filePath: string,
  options?: StagePrintFileOptions,
): {
  analysisId: string;
  metrics: PrintFileMetrics;
  expiresAt: string;
} {
  return stageParsedPrintFile(
    fileName,
    enrichPrintFileMetricsWithResinCost(parseSlicePath(fileName, filePath, options)),
  );
}

/**
 * Stage a CTB from a browser-sampled prefix. `fullFileSize` is the real plate
 * size on the owner's machine (Mega 8K plates are often hundreds of MB).
 */
export function stageCtbFromPrefix(fileName: string, prefixPath: string, fullFileSize: number): {
  analysisId: string;
  metrics: PrintFileMetrics;
  expiresAt: string;
} {
  if (!/\.ctb$/i.test(fileName.trim())) {
    throw new CtbParseError("Prefix sampling is only supported for Chitubox .ctb plates");
  }
  const prefix = fs.readFileSync(prefixPath);
  return stageParsedPrintFile(
    fileName,
    enrichPrintFileMetricsWithResinCost(parseCtbFileFromPrefix(fileName, prefix, fullFileSize)),
  );
}

function stageParsedPrintFile(
  _fileName: string,
  metrics: PrintFileMetrics,
): {
  analysisId: string;
  metrics: PrintFileMetrics;
  expiresAt: string;
} {
  const id = crypto.randomUUID();
  const expiry = expiresAt();
  getDb()
    .insert(printFileAnalyses)
    .values({
      id,
      metricsJson: JSON.stringify(metrics),
      createdAt: nowIso(),
      expiresAt: expiry,
    })
    .run();
  return { analysisId: id, metrics, expiresAt: expiry };
}

export function getStagedPrintFile(analysisId: string): {
  analysis: PrintFileAnalysis;
  metrics: PrintFileMetrics;
} | null {
  const analysis = getDb()
    .select()
    .from(printFileAnalyses)
    .where(eq(printFileAnalyses.id, analysisId))
    .get();
  if (!analysis || analysis.usedAt || analysis.expiresAt <= nowIso()) return null;
  const metrics = parseMetrics(analysis.metricsJson);
  return metrics ? { analysis, metrics: enrichPrintFileMetricsWithResinCost(metrics) } : null;
}

export function markPrintFileAnalysisUsed(analysisId: string): void {
  getDb()
    .update(printFileAnalyses)
    .set({ usedAt: nowIso() })
    .where(eq(printFileAnalyses.id, analysisId))
    .run();
}

export function createPrintFileRecord(input: {
  analysisId: string;
  hubspotDealId: string;
  hubspotDealName: string;
  dealStage: string;
  metrics: PrintFileMetrics;
  /** Physical fleet printer override when the CTB only has a shared model name. */
  fleetPrinterId?: number | null;
}): PrintFileRecord {
  const { metrics } = input;
  const attachedAt = nowIso();
  return getDb()
    .insert(printFileRecords)
    .values({
      analysisId: input.analysisId,
      hubspotDealId: input.hubspotDealId,
      hubspotDealName: input.hubspotDealName,
      dealStage: input.dealStage,
      fileName: metrics.fileName,
      fileSizeBytes: metrics.fileSizeBytes,
      sha256: metrics.sha256,
      formatRevision: metrics.formatRevision,
      printTimeSeconds: metrics.printTimeSeconds,
      resinVolumeMl: decimal(metrics.resinVolumeMl),
      resinMassG: decimal(metrics.resinMassG),
      resinCost: decimal(metrics.resinCost),
      resinCostSource: metrics.resinCostSource,
      resinCostLabel: metrics.resinCostLabel,
      resinDensityGPerMl: decimal(metrics.resinDensityGPerMl),
      layerCount: metrics.layerCount,
      layerHeightMm: decimal(metrics.layerHeightMm),
      modelHeightMm: decimal(metrics.modelHeightMm),
      exposureSeconds: decimal(metrics.exposureSeconds),
      bottomExposureSeconds: decimal(metrics.bottomExposureSeconds),
      lightOffSeconds: decimal(metrics.lightOffSeconds),
      bottomLightOffSeconds: decimal(metrics.bottomLightOffSeconds),
      bottomLayerCount: metrics.bottomLayerCount,
      liftDistanceMm: decimal(metrics.liftDistanceMm),
      liftSpeedMmPerMin: decimal(metrics.liftSpeedMmPerMin),
      bottomLiftDistanceMm: decimal(metrics.bottomLiftDistanceMm),
      bottomLiftSpeedMmPerMin: decimal(metrics.bottomLiftSpeedMmPerMin),
      retractSpeedMmPerMin: decimal(metrics.retractSpeedMmPerMin),
      resolutionX: metrics.resolutionX,
      resolutionY: metrics.resolutionY,
      printerProfile: metrics.printerProfile,
      fleetPrinterId: input.fleetPrinterId ?? null,
      hubspotSyncedAt: attachedAt,
      attachedAt,
    })
    .returning()
    .get();
}

export function listPrintFileRecords(limit = 100): PrintFileRecord[] {
  return getDb()
    .select()
    .from(printFileRecords)
    .orderBy(desc(printFileRecords.attachedAt), desc(printFileRecords.id))
    .limit(Math.max(1, Math.min(limit, 500)))
    .all();
}

/**
 * Keep plate-history stage/name in sync with live HubSpot Print Orders.
 * Called when loading Prints / Performance so older attach snapshots
 * (e.g. "Queued to Print") catch up after the deal moves.
 */
export function syncPrintFileDealStages(
  liveByDealId: Map<string, { stage: string; dealName?: string }>,
): number {
  if (liveByDealId.size === 0) return 0;
  const db = getDb();
  let updated = 0;
  for (const [dealId, live] of Array.from(liveByDealId.entries())) {
    const stage = live.stage.trim();
    if (!stage) continue;
    const dealName = live.dealName?.trim();
    const patch: { dealStage: string; hubspotDealName?: string } = { dealStage: stage };
    if (dealName) patch.hubspotDealName = dealName;
    const result = db
      .update(printFileRecords)
      .set(patch)
      .where(eq(printFileRecords.hubspotDealId, dealId))
      .run();
    updated += Number(result.changes ?? 0);
  }
  return updated;
}

export function listPrintFileRecordsForDeal(hubspotDealId: string): PrintFileRecord[] {
  return listPrintFileRecords(500).filter((record) => record.hubspotDealId === hubspotDealId);
}

export function getPrintFileRecord(recordId: number): PrintFileRecord | null {
  return getDb().select().from(printFileRecords).where(eq(printFileRecords.id, recordId)).get() ?? null;
}

export function deletePrintFileRecord(recordId: number): PrintFileRecord | null {
  const existing = getPrintFileRecord(recordId);
  if (!existing) return null;
  getDb().delete(printFileRecords).where(eq(printFileRecords.id, recordId)).run();
  return existing;
}

/** Any historical attachment marks a deal as having print-file planning data. */
export function attachedPrintFileDealIds(): Set<string> {
  return new Set(listPrintFileRecords(500).map((record) => record.hubspotDealId));
}

function asNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function total(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

function recordToMetrics(record: PrintFileRecord): PrintFileMetrics {
  return {
    fileName: record.fileName,
    fileSizeBytes: record.fileSizeBytes,
    sha256: record.sha256,
    format: "CTB",
    formatRevision: record.formatRevision,
    printTimeSeconds: record.printTimeSeconds,
    resinVolumeMl: asNumber(record.resinVolumeMl),
    resinMassG: asNumber(record.resinMassG),
    resinCost: asNumber(record.resinCost),
    resinCostSource: record.resinCostSource as PrintFileMetrics["resinCostSource"],
    resinCostLabel: record.resinCostLabel,
    resinDensityGPerMl: asNumber(record.resinDensityGPerMl),
    layerCount: record.layerCount,
    layerHeightMm: asNumber(record.layerHeightMm),
    modelHeightMm: asNumber(record.modelHeightMm),
    exposureSeconds: asNumber(record.exposureSeconds),
    bottomExposureSeconds: asNumber(record.bottomExposureSeconds),
    lightOffSeconds: asNumber(record.lightOffSeconds),
    bottomLightOffSeconds: asNumber(record.bottomLightOffSeconds),
    bottomLayerCount: record.bottomLayerCount,
    liftDistanceMm: asNumber(record.liftDistanceMm),
    liftSpeedMmPerMin: asNumber(record.liftSpeedMmPerMin),
    bottomLiftDistanceMm: asNumber(record.bottomLiftDistanceMm),
    bottomLiftSpeedMmPerMin: asNumber(record.bottomLiftSpeedMmPerMin),
    retractSpeedMmPerMin: asNumber(record.retractSpeedMmPerMin),
    resolutionX: record.resolutionX,
    resolutionY: record.resolutionY,
    buildVolumeXmm: null,
    buildVolumeYmm: null,
    buildVolumeZmm: null,
    printerProfile: record.printerProfile,
  };
}

/** Rebuild a deal's cumulative plan from its remaining local plates. */
export function buildPrintFileOrderSummaryFromRecords(
  hubspotDealId: string,
  options?: { excludeRecordId?: number },
): PrintFileOrderSummary | null {
  const records = listPrintFileRecordsForDeal(hubspotDealId).filter(
    (record) => record.id !== options?.excludeRecordId,
  );
  if (!records.length) return null;
  const ordered = [...records].sort(
    (a, b) => b.attachedAt.localeCompare(a.attachedAt) || b.id - a.id,
  );
  const latest = recordToMetrics(ordered[0]!);
  return {
    plateCount: ordered.length,
    totalPrintTimeSeconds: total(ordered.map((record) => record.printTimeSeconds)),
    totalResinVolumeMl: total(ordered.map((record) => asNumber(record.resinVolumeMl))),
    totalResinMassG: total(ordered.map((record) => asNumber(record.resinMassG))),
    totalResinCost: total(ordered.map((record) => asNumber(record.resinCost))),
    totalLayerCount: total(ordered.map((record) => record.layerCount)),
    latest,
  };
}

/** Preview the resulting production plan without writing HubSpot. */
export function previewAttachSummary(
  hubspotDealId: string,
  latest: PrintFileMetrics | null,
): PrintFileOrderSummary | null {
  return latest
    ? buildPrintFileOrderSummary(hubspotDealId, latest)
    : buildPrintFileOrderSummaryFromRecords(hubspotDealId);
}

export function groupPrintFileRecordsByDeal(limit = 100): PrintFileDealBoard[] {
  const boards = new Map<string, PrintFileDealBoard>();
  for (const record of listPrintFileRecords(limit)) {
    const existing = boards.get(record.hubspotDealId);
    if (!existing) {
      boards.set(record.hubspotDealId, {
        dealId: record.hubspotDealId,
        dealName: record.hubspotDealName,
        dealStage: record.dealStage,
        plateCount: 1,
        totalPrintTimeSeconds: record.printTimeSeconds,
        totalResinVolumeMl: asNumber(record.resinVolumeMl),
        totalResinMassG: asNumber(record.resinMassG),
        totalResinCost: asNumber(record.resinCost),
        latestAttachedAt: record.attachedAt,
        records: [record],
      });
      continue;
    }
    existing.records.push(record);
    existing.plateCount += 1;
    existing.totalPrintTimeSeconds = total([existing.totalPrintTimeSeconds, record.printTimeSeconds]);
    existing.totalResinVolumeMl = total([existing.totalResinVolumeMl, asNumber(record.resinVolumeMl)]);
    existing.totalResinMassG = total([existing.totalResinMassG, asNumber(record.resinMassG)]);
    existing.totalResinCost = total([existing.totalResinCost, asNumber(record.resinCost)]);
  }
  return Array.from(boards.values()).sort(
    (a, b) => b.latestAttachedAt.localeCompare(a.latestAttachedAt),
  );
}

/**
 * Calculate the running plan before the new record is persisted. This lets the
 * HubSpot PATCH happen first while still including the plate the owner is
 * attaching right now.
 */
export function buildPrintFileOrderSummary(
  hubspotDealId: string,
  latest: PrintFileMetrics,
): PrintFileOrderSummary {
  const existing = listPrintFileRecordsForDeal(hubspotDealId);
  return {
    plateCount: existing.length + 1,
    totalPrintTimeSeconds: total([
      ...existing.map((record) => record.printTimeSeconds),
      latest.printTimeSeconds,
    ]),
    totalResinVolumeMl: total([
      ...existing.map((record) => asNumber(record.resinVolumeMl)),
      latest.resinVolumeMl,
    ]),
    totalResinMassG: total([
      ...existing.map((record) => asNumber(record.resinMassG)),
      latest.resinMassG,
    ]),
    totalResinCost: total([
      ...existing.map((record) => asNumber(record.resinCost)),
      latest.resinCost,
    ]),
    totalLayerCount: total([
      ...existing.map((record) => record.layerCount),
      latest.layerCount,
    ]),
    latest,
  };
}
