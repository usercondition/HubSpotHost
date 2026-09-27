import { apiRequest } from "@/lib/queryClient";
import { guessPlatePrinter, type PlateFileRecord } from "@shared/plate-files";

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
