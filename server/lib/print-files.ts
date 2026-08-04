/**
 * Local tracking for CTB production metadata.
 *
 * Uploaded slicer files are parsed from temp disk (header ranges only) and
 * discarded. Short-lived analyses let the owner choose a deal before attach.
 * Only extracted values and fingerprints are retained in SQLite.
 */
import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  printFileAnalyses,
  printFileRecords,
  type PrintFileAnalysis,
  type PrintFileDealBoard,
  type PrintFileMetrics,
  type PrintFileOrderSummary,
  type PrintFileRecord,
  type ResinCostSource,
} from "../../shared/schema";
import { getDb } from "./order-links";
import { parseCtbFile, parseCtbFileFromPath } from "./ctb";
import { enrichPrintFileMetricsWithResinCost } from "./resin-pricing";

export const PRINT_FILE_ANALYSIS_TTL_MINUTES = 20;

function nowIso(): string {
  return new Date().toISOString();
}

function expiresAt(): string {
  return new Date(Date.now() + PRINT_FILE_ANALYSIS_TTL_MINUTES * 60_000).toISOString();
}

function decimal(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function total(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

function parseMetrics(value: string): PrintFileMetrics | null {
  try {
    const parsed = JSON.parse(value) as Partial<PrintFileMetrics>;
    if (
      parsed.format !== "CTB" ||
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

export function stagePrintFile(fileName: string, buffer: Buffer): {
  analysisId: string;
  metrics: PrintFileMetrics;
  expiresAt: string;
} {
  return stageParsedPrintFile(enrichPrintFileMetricsWithResinCost(parseCtbFile(fileName, buffer)));
}

/** Stage a CTB that was uploaded to a temporary disk path (preferred for large plates). */
export function stagePrintFileFromPath(fileName: string, filePath: string): {
  analysisId: string;
  metrics: PrintFileMetrics;
  expiresAt: string;
} {
  return stageParsedPrintFile(
    enrichPrintFileMetricsWithResinCost(parseCtbFileFromPath(fileName, filePath)),
  );
}

function stageParsedPrintFile(metrics: PrintFileMetrics): {
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
      buildVolumeXmm: decimal(metrics.buildVolumeXmm),
      buildVolumeYmm: decimal(metrics.buildVolumeYmm),
      buildVolumeZmm: decimal(metrics.buildVolumeZmm),
      printerProfile: metrics.printerProfile,
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

export function listPrintFileRecordsForDeal(hubspotDealId: string): PrintFileRecord[] {
  return listPrintFileRecords(500).filter((record) => record.hubspotDealId === hubspotDealId);
}

export function getPrintFileRecord(recordId: number): PrintFileRecord | null {
  return (
    getDb().select().from(printFileRecords).where(eq(printFileRecords.id, recordId)).get() ?? null
  );
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

export function recordToMetrics(record: PrintFileRecord): PrintFileMetrics {
  const source = record.resinCostSource;
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
    resinCostSource:
      source === "ctb" || source === "amazon" || source === "supplies" || source === "manual"
        ? (source as ResinCostSource)
        : null,
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
    buildVolumeXmm: asNumber(record.buildVolumeXmm),
    buildVolumeYmm: asNumber(record.buildVolumeYmm),
    buildVolumeZmm: asNumber(record.buildVolumeZmm),
    printerProfile: record.printerProfile,
  };
}

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

/** Rebuild HubSpot-facing totals from remaining local plates after a detach. */
export function buildPrintFileOrderSummaryFromRecords(
  hubspotDealId: string,
  options?: { excludeRecordId?: number },
): PrintFileOrderSummary | null {
  const existing = listPrintFileRecordsForDeal(hubspotDealId).filter(
    (record) => record.id !== options?.excludeRecordId,
  );
  if (!existing.length) return null;
  const ordered = [...existing].sort((a, b) => {
    const byTime = b.attachedAt.localeCompare(a.attachedAt);
    return byTime !== 0 ? byTime : b.id - a.id;
  });
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

export function previewAttachSummary(
  hubspotDealId: string,
  latest: PrintFileMetrics | null,
): PrintFileOrderSummary | null {
  if (!latest) {
    return buildPrintFileOrderSummaryFromRecords(hubspotDealId);
  }
  return buildPrintFileOrderSummary(hubspotDealId, latest);
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
    if (record.attachedAt > existing.latestAttachedAt) {
      existing.latestAttachedAt = record.attachedAt;
      existing.dealName = record.hubspotDealName;
      existing.dealStage = record.dealStage;
    }
  }

  return Array.from(boards.values()).sort((a, b) =>
    b.latestAttachedAt.localeCompare(a.latestAttachedAt),
  );
}
