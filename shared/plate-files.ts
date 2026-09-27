import { z } from "zod";

/** Slice and mesh files Miguel attaches to an order. */
export const PLATE_FILE_EXTENSIONS = [".ctb", ".ultx", ".chitubox", ".cbddlp", ".goo", ".prz", ".lys", ".stl", ".3mf"] as const;

export const PLATE_PRINTERS = ["Mighty 8K", "Mighty 12K", "MEGA 8K", "HeyGears", "other"] as const;
export type PlatePrinter = (typeof PLATE_PRINTERS)[number];

export const PLATE_FILE_SOURCES = ["upload", "indexed"] as const;
export type PlateFileSource = (typeof PLATE_FILE_SOURCES)[number];

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_OAUTH_CALLBACK_PATH = "/api/google/oauth/callback";

export const plateOrderKeySchema = z
  .string()
  .trim()
  .regex(/^(deal:[0-9]{1,20}|offbook:[1-9][0-9]*)$/, "Use a deal or off-book order key");

export function plateExtension(fileName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  return match ? `.${match[1].toLowerCase()}` : "";
}

export function isPlateFileName(fileName: string): boolean {
  return (PLATE_FILE_EXTENSIONS as readonly string[]).includes(plateExtension(fileName));
}

/** Printers Miguel filters the Library by. */
export const LIBRARY_PRINTER_FILTERS = ["Mighty 8K", "Mighty 12K", "MEGA 8K", "HeyGears"] as const;

/** Plate label without the extension, for kit search and reuse. */
export function platePartName(fileName: string): string {
  const base = fileName.trim().replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || fileName.trim() || "Plate";
}

/**
 * Catalog name for a sliced kit. The buyer is not part of the library.
 * "Knight - Castellan - Glenn Casey Chandler" → "Knight Castellan".
 * "Cerastus Chassis - Castigator - Wayne Hood" → "Cerastus Castigator".
 */
export function libraryKitName(source: string, contactName?: string | null): string {
  let title = source.trim();
  const contact = contactName?.trim();
  if (contact) {
    for (const suffix of [` - ${contact}`, ` – ${contact}`, ` — ${contact}`, ` · ${contact}`]) {
      if (title.toLowerCase().endsWith(suffix.toLowerCase())) {
        const cut = title.slice(0, -suffix.length).trim();
        if (cut) title = cut;
        break;
      }
    }
  } else {
    const parts = title.split(/\s+[–—-]\s+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 3) title = parts.slice(0, -1).join(" - ");
    else if (parts.length === 2 && (parts[1]?.split(/\s+/).length ?? 0) >= 2) title = parts[0] ?? title;
  }
  const words = title
    .split(/\s+[–—-]\s+|\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0 && word.toLowerCase() !== "chassis");
  return words.join(" ").slice(0, 180) || "Kit";
}

function customerMatcher(customer: string): RegExp | null {
  const contact = customer.trim();
  if (!contact) return null;
  const body = contact
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s_–—-]+");
  return new RegExp(`(?:^${body}(?=$|[\\s_–—-]+))|(?:(?:^|[\\s_–—-]+)${body}$)`, "ig");
}

/** File name stored in Drive and the Library. The contact is not part of the slice. */
export function librarySliceName(fileName: string, customer?: string | null): string {
  const ext = plateExtension(fileName);
  const raw = fileName.trim();
  let base = ext ? raw.slice(0, -ext.length) : raw;
  const matcher = customerMatcher(customer ?? "");
  if (matcher) {
    base = base.replace(matcher, " ");
    base = base.replace(/(?:^[\s_\-–—]+)|(?:[\s_\-–—]+$)/g, "");
  }
  base = base.replace(/\s+/g, " ").trim();
  if (!base) base = "plate";
  return `${base}${ext}`.slice(0, 240);
}

/** Drop a known contact from notes or other catalog text. */
export function libraryCatalogText(text: string, customer?: string | null): string {
  const matcher = customerMatcher(customer ?? "");
  if (!matcher || !text) return text;
  return text.replace(matcher, " ").replace(/\s+/g, " ").trim();
}

/** Drive folder title for a catalog kit. Does not strip a name Miguel typed. */
export function libraryFolderName(kit: string): string {
  const name = kit.trim().replace(/[\\/]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
  return name || "Kit";
}

export function usedOnOrders(count: number): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return n === 1 ? "Used on 1 order" : `Used on ${n} orders`;
}

/** Prefill a printer when the slicer put it in the file name. */
export function guessPlatePrinter(fileName: string): PlatePrinter | "" {
  if (plateExtension(fileName) === ".ultx") return "HeyGears";
  const name = fileName.toLowerCase().replace(/[_-]+/g, " ");
  if (name.includes("mega 8k") || name.includes("mega8k")) return "MEGA 8K";
  if (name.includes("12k")) return "Mighty 12K";
  if (name.includes("heygear")) return "HeyGears";
  if (name.includes("mighty 8k") || name.includes("8k")) return "Mighty 8K";
  return "";
}

export const plateKitRenameSchema = z.object({
  from: z.string().trim().min(1).max(180),
  to: z.string().trim().min(1).max(180),
});

export const plateFileIndexSchema = z.object({
  driveFileId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(240),
  webViewLink: z.string().trim().max(500).optional().default(""),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  modifiedAt: z.string().trim().max(40).nullable().optional(),
  mimeType: z.string().trim().max(120).optional().default(""),
  extension: z.string().trim().max(20).optional().default(""),
  printer: z.string().trim().max(40).optional().default(""),
  kit: z.string().trim().max(180).optional().default(""),
  customer: z.string().trim().max(120).optional().default(""),
  kitTags: z.string().trim().max(240).optional().default(""),
  notes: z.string().trim().max(2000).optional().default(""),
  sha256: z.string().trim().max(64).optional().default(""),
  orderKeys: z.array(plateOrderKeySchema).max(20).optional(),
});

export const plateUploadQuerySchema = z.object({
  orderKey: plateOrderKeySchema,
  fileName: z.string().trim().min(1).max(240),
  printer: z.string().trim().max(40).optional().default(""),
  notes: z.string().trim().max(2000).optional().default(""),
  kit: z.string().trim().max(180).optional().default(""),
  customer: z.string().trim().max(120).optional().default(""),
  sha256: z.string().trim().max(64).optional().default(""),
  printRecordId: z.string().trim().max(20).optional().default(""),
});

export const platePrepareSchema = z.object({
  orderKey: plateOrderKeySchema,
  sha256: z.string().trim().regex(/^[a-f0-9]{64}$/, "Use the plate fingerprint"),
  fileName: z.string().trim().min(1).max(240),
  printRecordId: z.number().int().positive().optional(),
  printer: z.string().trim().max(40).optional().default(""),
  kit: z.string().trim().max(180).optional().default(""),
  customer: z.string().trim().max(120).optional().default(""),
});

export const plateDownloadSchema = z.object({
  driveFileId: z.string().trim().min(1).max(200),
});

export const plateFileBulkSchema = z.object({
  files: z.array(plateFileIndexSchema).min(1).max(100),
});

export const plateFileLinkSchema = z.object({
  driveFileId: z.string().trim().min(1).max(200),
  orderKey: plateOrderKeySchema,
});

export interface PlatePreviewStats {
  printerProfile: string;
  layerCount: number | null;
  layerHeightMm: number | null;
  printTimeSeconds: number | null;
  resinVolumeMl: number | null;
  resinCost: number | null;
}

export interface PlateFileRecord {
  driveFileId: string;
  name: string;
  webViewLink: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  mimeType: string;
  extension: string;
  printer: string;
  kit: string;
  customer: string;
  kitTags: string;
  notes: string;
  source: PlateFileSource;
  sha256: string;
  orderKeys: string[];
  printRecordIds: number[];
  hasPreview: boolean;
  stats: PlatePreviewStats | null;
}

export interface PlateLibraryPending {
  printRecordId: number;
  orderKey: string;
  name: string;
  sha256: string;
  error: string;
}

export interface PrintLibraryMark {
  status: "in_library" | "pending" | "missing";
  driveFileId: string;
  error: string;
}

/** Catalog row for the Library page. Contact names stay off the response. */
export function libraryCatalogRecord<T extends PlateFileRecord>(file: T): T {
  const customer = file.customer;
  return {
    ...file,
    name: librarySliceName(file.name, customer),
    kit: libraryKitName(file.kit || file.name, customer),
    kitTags: libraryKitName(file.kitTags || file.kit || file.name, customer),
    notes: libraryCatalogText(file.notes, customer),
    customer: "",
  };
}

export interface PlateUploadFailure {
  id: number;
  orderKey: string;
  name: string;
  printer: string;
  notes: string;
  error: string;
  createdAt: string;
}
