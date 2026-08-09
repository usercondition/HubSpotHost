/**
 * Shared Prints analyze/attach helpers.
 * Keeps Slice.log resolution + printer choice rules in one place for Prints
 * (and any future Kits rebuild).
 */
import { apiRequest } from "@/lib/queryClient";
import { buildSliceLogUploadFromLinkedFolder } from "@/lib/blueprint-slice-log";
import type { PrintFileMetrics, PrintFileOrderSummary, PrintFileRecord } from "@shared/schema";

export type PrinterMatchInfo = {
  matchedPrinterId: number | null;
  requiresPrinterChoice: boolean;
  sharedModelProfile?: boolean;
  slicerProfile: string | null;
  printers: Array<{ id: number; name: string; model: string }>;
};

export type AnalyzePrintResult = {
  ok: true;
  analysisId: string;
  metrics: PrintFileMetrics;
  expiresAt: string;
  sliceLogApplied?: boolean;
  printerMatch?: PrinterMatchInfo;
};

export type AttachPrintResult = {
  ok: true;
  record: PrintFileRecord;
  summary: PrintFileOrderSummary;
  message: string;
};

const SLICE_LOG_MEMORY_KEY = "hubspot-print-slice-log-v1";
const SLICE_LOG_MEMORY_MAX_CHARS = 2 * 1024 * 1024;

export function isSliceLogFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name === "slice.log" || /^slice(?:-.*)?\.log$/.test(name);
}

export function isPlateFile(file: File): boolean {
  return /\.(ctb|ultx)$/i.test(file.name);
}

export function readRememberedSliceLog(): { name: string; text: string } | null {
  try {
    const raw = sessionStorage.getItem(SLICE_LOG_MEMORY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { name?: string; text?: string };
    if (!parsed?.text || !parsed?.name) return null;
    return { name: parsed.name, text: parsed.text };
  } catch {
    return null;
  }
}

export function rememberSliceLog(name: string, text: string): void {
  const clipped =
    text.length > SLICE_LOG_MEMORY_MAX_CHARS ? text.slice(text.length - SLICE_LOG_MEMORY_MAX_CHARS) : text;
  sessionStorage.setItem(
    SLICE_LOG_MEMORY_KEY,
    JSON.stringify({ name, text: clipped, savedAt: Date.now() }),
  );
}

export function clearRememberedSliceLog(): void {
  sessionStorage.removeItem(SLICE_LOG_MEMORY_KEY);
}

/** Resolve Slice.log for a plate: explicit file → linked/import folder → session memory. */
export async function resolveSliceLogForAnalyze(
  plateFile: File,
  sliceLog?: File | null,
): Promise<{ file: File | null; rememberedFromFolder: boolean }> {
  if (sliceLog) return { file: sliceLog, rememberedFromFolder: false };
  if (!/\.ultx$/i.test(plateFile.name)) return { file: null, rememberedFromFolder: false };

  const fromFolder = await buildSliceLogUploadFromLinkedFolder(plateFile.name);
  if (fromFolder) return { file: fromFolder, rememberedFromFolder: true };

  const remembered = readRememberedSliceLog();
  if (remembered) {
    return {
      file: new File([remembered.text], remembered.name || "Slice.log", { type: "text/plain" }),
      rememberedFromFolder: false,
    };
  }
  return { file: null, rememberedFromFolder: false };
}

export async function analyzePrintPlate(
  file: File,
  options: {
    headers: Record<string, string>;
    sliceLog?: File | null;
    onSliceLogApplied?: (name: string) => void;
  },
): Promise<AnalyzePrintResult> {
  const form = new FormData();
  form.append("file", file);
  const resolved = await resolveSliceLogForAnalyze(file, options.sliceLog);
  if (resolved.file) {
    form.append("sliceLog", resolved.file);
    if (resolved.rememberedFromFolder) {
      void resolved.file.text().then((text) => {
        rememberSliceLog(resolved.file!.name, text);
        options.onSliceLogApplied?.(resolved.file!.name);
      });
    }
  }
  const response = await apiRequest("POST", "/api/prints/analyze", form, { headers: options.headers });
  return (await response.json()) as AnalyzePrintResult;
}

export function initialAttachPrinterId(printerMatch?: PrinterMatchInfo | null): string {
  if (!printerMatch || printerMatch.requiresPrinterChoice) return "";
  if (printerMatch.matchedPrinterId) return String(printerMatch.matchedPrinterId);
  return "";
}

export function assertAttachPrinterReady(
  printerMatch: PrinterMatchInfo | undefined,
  attachPrinterId: string,
): void {
  const needsPrinter =
    printerMatch?.requiresPrinterChoice || (!printerMatch?.matchedPrinterId && !attachPrinterId);
  if (needsPrinter && !attachPrinterId) {
    throw new Error(
      "Choose which physical printer ran this plate (Chitubox did not embed NEWX1/NEWX2/NEWX3).",
    );
  }
}

export async function attachPrintPlate(input: {
  analysisId: string;
  dealId: string;
  printerId?: number | null;
  headers: Record<string, string>;
}): Promise<AttachPrintResult> {
  const response = await apiRequest(
    "POST",
    "/api/prints/attach",
    {
      analysisId: input.analysisId,
      dealId: input.dealId,
      ...(input.printerId ? { printerId: input.printerId } : {}),
    },
    { headers: input.headers },
  );
  return (await response.json()) as AttachPrintResult;
}
