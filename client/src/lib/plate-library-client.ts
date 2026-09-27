import { apiRequest } from "@/lib/queryClient";
import { analyzePrintPlate, attachPrintPlate, isPlateFile, type PrinterMatchInfo } from "@/lib/print-attach";
import { guessPlatePrinter, type PlateFileRecord } from "@shared/plate-files";
import type { PrintFileMetrics, PrintFileOrderSummary, PrintFileRecord } from "@shared/schema";

const heldFiles = new Map<string, File>();

export function holdSliceFile(sha256: string, file: File): void {
  heldFiles.set(sha256, file);
}

export function heldSliceFile(sha256: string): File | undefined {
  return heldFiles.get(sha256);
}

export async function fingerprintFile(file: File): Promise<string> {
  const sizeBuf = new Uint8Array(8);
  new DataView(sizeBuf.buffer).setBigUint64(0, BigInt(file.size), true);
  const prefix = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
  const data = new Uint8Array(8 + prefix.length);
  data.set(sizeBuf, 0);
  data.set(prefix, 8);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function splitDealTitle(dealName: string): { kit: string; customer: string } {
  const parts = dealName.split(/\s+[–-]\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) return { kit: parts[0], customer: parts.slice(1).join(" - ") };
  return { kit: dealName.trim() || "Order", customer: "" };
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
      else reject(new Error(parsed.error || "Drive upload failed."));
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
      return { library: "pending", libraryError: "Not in Library yet. Connect Drive or retry.", file: null };
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
    const libraryError = error instanceof Error ? error.message : "Drive upload failed.";
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
