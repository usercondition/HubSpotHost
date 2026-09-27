import { apiRequest } from "@/lib/queryClient";
import { analyzePrintPlate, attachPrintPlate, isPlateFile, type PrinterMatchInfo } from "@/lib/print-attach";
import { guessPlatePrinter, libraryKitName, type PlateFileRecord } from "@shared/plate-files";
import { SLICE_FINGERPRINT_CHUNK, fingerprintPayload } from "@shared/slice-fingerprint";
import type { PrintFileMetrics, PrintFileOrderSummary, PrintFileRecord } from "@shared/schema";

const heldFiles = new Map<string, File>();

export function holdSliceFile(sha256: string, file: File): void {
  heldFiles.set(sha256, file);
}

export function heldSliceFile(sha256: string): File | undefined {
  return heldFiles.get(sha256);
}

/** Shop copy for Drive failures. Raw provider text stays on the server log. */
export function plainDriveMessage(message: string, fallback = "Drive upload failed."): string {
  const embedded = /"error"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  const text = (embedded || message).replace(/^\d{3}:\s*/, "").trim();
  if (/reconnect/i.test(text)) return "Reconnect Google Drive.";
  if (/not in library|not configured/i.test(text)) return "Not in Library yet.";
  if (/does not match/i.test(text)) return "That file does not match this plate.";
  if (/could not read|unreadable/i.test(text)) return "Drive could not read that file.";
  if (/did not finish/i.test(text)) return "The upload did not finish.";
  if (text === "Drive upload failed." || text === "Choose which physical printer ran this plate.") return text;
  if (/googleapis|invalid_grant|ya29\.|\bError:|ECONN|ETIMEDOUT|oauth|unexpected token|status code/i.test(text)) return fallback;
  if (!text || text.length > 160 || /[{}<>]/.test(text)) return fallback;
  return text;
}

export async function fingerprintFile(file: File): Promise<string> {
  const headLen = Math.min(file.size, SLICE_FINGERPRINT_CHUNK);
  const tailLen = Math.min(file.size, SLICE_FINGERPRINT_CHUNK);
  const head = new Uint8Array(await file.slice(0, headLen).arrayBuffer());
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - tailLen)).arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", fingerprintPayload(file.size, head, tail));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function splitDealTitle(dealName: string): { kit: string; customer: string } {
  const parts = dealName.split(/\s+[–—-]\s+/).map((part) => part.trim()).filter(Boolean);
  const last = parts.length >= 2 ? parts[parts.length - 1] ?? "" : "";
  const customer = last.split(/\s+/).length >= 2 ? last : "";
  return { kit: libraryKitName(dealName, customer || undefined), customer };
}

export type PrepareResult =
  | { action: "linked"; file: PlateFileRecord | null }
  | { action: "pending"; reason: string }
  | { action: "upload" };

export async function preparePlateUpload(
  input: {
    orderKey: string;
    sha256: string;
    fileName: string;
    printRecordId?: number;
    printer?: string;
    kit?: string;
    customer?: string;
  },
  headers: Record<string, string>,
): Promise<PrepareResult> {
  const response = await apiRequest("POST", "/api/plate-files/prepare", input, { headers });
  const body = (await response.json()) as { action?: string; reason?: string; file?: PlateFileRecord };
  if (body.action === "linked") return { action: "linked", file: body.file ?? null };
  if (body.action === "pending") return { action: "pending", reason: body.reason || "not_connected" };
  return { action: "upload" };
}

export function uploadPlateBytes(input: {
  file: File;
  orderKey: string;
  printer: string;
  notes: string;
  kit: string;
  customer: string;
  sha256: string;
  printRecordId?: number;
  headers: Record<string, string>;
  onProgress: (fraction: number) => void;
  /** Parent plate id when this file is an STL/3MF for that plate, not a new catalog row. */
  modelFor?: string;
}): Promise<PlateFileRecord> {
  const params = new URLSearchParams({
    orderKey: input.orderKey,
    fileName: input.file.name,
    printer: input.printer || guessPlatePrinter(input.file.name),
    notes: input.notes,
    kit: input.kit,
    customer: input.customer,
    sha256: input.sha256,
  });
  if (input.printRecordId) params.set("printRecordId", String(input.printRecordId));
  if (input.modelFor) params.set("modelFor", input.modelFor);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/plate-files/upload?${params.toString()}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    for (const [key, value] of Object.entries(input.headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) input.onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let parsed: { file?: PlateFileRecord; error?: string } = {};
      try {
        parsed = JSON.parse(xhr.responseText) as typeof parsed;
      } catch {
        parsed = {};
      }
      if (xhr.status >= 200 && xhr.status < 300 && parsed.file?.driveFileId) resolve(parsed.file);
      else reject(new Error(plainDriveMessage(parsed.error || "Drive upload failed.")));
    };
    xhr.onerror = () => reject(new Error("Drive upload failed."));
    xhr.send(input.file);
  });
}

export class SlicePrinterChoiceError extends Error {
  printers: Array<{ id: number; name: string; model: string }>;

  constructor(printers: Array<{ id: number; name: string; model: string }>) {
    super("Choose which physical printer ran this plate.");
    this.name = "SlicePrinterChoiceError";
    this.printers = printers;
  }
}

export type SliceCommitResult = {
  record: PrintFileRecord | null;
  linkedRecord: boolean;
  summary: PrintFileOrderSummary | null;
  message: string;
  library: "uploaded" | "linked" | "pending";
  libraryError: string;
  file: PlateFileRecord | null;
};

function dealIdFromOrderKey(orderKey: string): string | null {
  const match = /^deal:([0-9]{1,20})$/.exec(orderKey);
  return match?.[1] ?? null;
}

/**
 * One upload for Prints and the Stack drawer: analyze, attach the print record,
 * then store the file in that order's Drive folder and the Library.
 * The same fingerprint on that order links what already exists.
 */
export async function commitSliceToOrder(input: {
  file: File;
  orderKey: string;
  headers: Record<string, string>;
  kit: string;
  customer: string;
  printer?: string;
  notes?: string;
  printerId?: number | null;
  sliceLog?: File | null;
  analysis?: { analysisId: string; metrics: PrintFileMetrics; printerMatch?: PrinterMatchInfo };
  onProgress?: (label: string, fraction: number) => void;
}): Promise<SliceCommitResult> {
  const printerLabel = input.printer || guessPlatePrinter(input.file.name);
  if (!isPlateFile(input.file)) {
    const sha256 = await fingerprintFile(input.file);
    const library = await storeSliceInLibrary({
      ...input,
      sha256,
      fileName: input.file.name,
      printer: printerLabel,
      printRecordId: undefined,
    });
    return {
      record: null,
      linkedRecord: false,
      summary: null,
      message: "",
      ...library,
    };
  }

  input.onProgress?.("Reading the plate", 0);
  const analyzed =
    input.analysis ??
    (await analyzePrintPlate(input.file, { headers: input.headers, sliceLog: input.sliceLog }));
  holdSliceFile(analyzed.metrics.sha256, input.file);

  let record: PrintFileRecord | null = null;
  let linkedRecord = false;
  let summary: PrintFileOrderSummary | null = null;
  let message = "";
  const dealId = dealIdFromOrderKey(input.orderKey);
  if (dealId) {
    const printerId = input.printerId || analyzed.printerMatch?.matchedPrinterId || null;
    if (analyzed.printerMatch?.requiresPrinterChoice && !printerId) {
      throw new SlicePrinterChoiceError(analyzed.printerMatch.printers);
    }
    input.onProgress?.("Attaching the plate", 0);
    const attached = await attachPrintPlate({
      analysisId: analyzed.analysisId,
      dealId,
      printerId,
      headers: input.headers,
    });
    record = attached.record;
    linkedRecord = attached.linked === true;
    summary = attached.summary;
    message = attached.message;
  }

  input.onProgress?.("Sending to Library", 0);
  const library = await storeSliceInLibrary({
    ...input,
    sha256: analyzed.metrics.sha256,
    fileName: input.file.name,
    printer: printerLabel,
    printRecordId: record?.id,
  });
  return { record, linkedRecord, summary, message, ...library };
}

async function storeSliceInLibrary(input: {
  file: File;
  orderKey: string;
  headers: Record<string, string>;
  kit: string;
  customer: string;
  notes?: string;
  sha256: string;
  fileName: string;
  printer: string;
  printRecordId?: number;
  onProgress?: (label: string, fraction: number) => void;
}): Promise<{ library: "uploaded" | "linked" | "pending"; libraryError: string; file: PlateFileRecord | null }> {
  try {
    const prepared = await preparePlateUpload(
      {
        orderKey: input.orderKey,
        sha256: input.sha256,
        fileName: input.fileName,
        printRecordId: input.printRecordId,
        printer: input.printer,
        kit: input.kit,
        customer: input.customer,
      },
      input.headers,
    );
    if (prepared.action === "linked") return { library: "linked", libraryError: "", file: prepared.file };
    if (prepared.action === "pending") {
      return { library: "pending", libraryError: "Not in Library yet.", file: null };
    }
    const file = await uploadPlateBytes({
      file: input.file,
      orderKey: input.orderKey,
      printer: input.printer,
      notes: input.notes || "",
      kit: input.kit,
      customer: input.customer,
      sha256: input.sha256,
      printRecordId: input.printRecordId,
      headers: input.headers,
      onProgress: (fraction) => input.onProgress?.("Sending to Library", fraction),
    });
    return { library: "uploaded", libraryError: "", file };
  } catch (error) {
    const libraryError = plainDriveMessage(error instanceof Error ? error.message : "");
    return { library: "pending", libraryError, file: null };
  }
}

export async function startPlateDownload(driveFileId: string, headers: Record<string, string>): Promise<void> {
  const response = await apiRequest("POST", "/api/plate-files/download", { driveFileId }, { headers });
  const body = (await response.json()) as { fallback?: boolean; webViewLink?: string; url?: string; fileName?: string };
  if (body.fallback && body.webViewLink) {
    window.open(body.webViewLink, "_blank", "noopener,noreferrer");
    return;
  }
  if (!body.url) throw new Error("Drive could not read that file.");
  const link = document.createElement("a");
  link.href = body.url;
  link.download = body.fileName || "slice-file";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
