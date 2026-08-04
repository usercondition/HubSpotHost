/**
 * Local tracking for CTB production metadata.
 *
 * A raw slicer file is parsed in memory and discarded. The short-lived
 * analysis lets the owner choose the correct deal before attaching it. Only
 * the extracted values and source file fingerprint are retained in SQLite.
 */
import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  printFileAnalyses,
  printFileRecords,
  type PrintFileAnalysis,
  type PrintFileMetrics,
  type PrintFileOrderSummary,
  type PrintFileRecord,
} from "../../shared/schema";
import { getDb } from "./order-links";
import { parseCtbFile } from "./ctb";
import { enrichPrintFileMetricsWithResinCost } from "./resin-pricing";

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
  const metrics = enrichPrintFileMetricsWithResinCost(parseCtbFile(fileName, buffer));
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

/**
 * Calculate the running plan before the new record is persisted. This lets the
 * HubSpot PATCH happen first while still including the plate the owner is
 * attaching right now.
 */
export function buildPrintFileOrderSummary(
  hubspotDealId: string,
  latest: PrintFileMetrics,
): PrintFileOrderSummary {
  const existing = listPrintFileRecords(500).filter(
    (record) => record.hubspotDealId === hubspotDealId,
  );
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
