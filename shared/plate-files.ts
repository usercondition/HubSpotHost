import { z } from "zod";

/** Slice and mesh files Miguel attaches to an order. */
export const PLATE_FILE_EXTENSIONS = [".ctb", ".chitubox", ".cbddlp", ".goo", ".prz", ".lys", ".stl", ".3mf"] as const;

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

/** Prefill a printer when the slicer put it in the file name. */
export function guessPlatePrinter(fileName: string): PlatePrinter | "" {
  const name = fileName.toLowerCase().replace(/[_-]+/g, " ");
  if (name.includes("mega 8k") || name.includes("mega8k")) return "MEGA 8K";
  if (name.includes("12k")) return "Mighty 12K";
  if (name.includes("heygear")) return "HeyGears";
  if (name.includes("mighty 8k") || name.includes("8k")) return "Mighty 8K";
  return "";
}

export function orderFolderName(kit: string, customer: string, orderKeyValue: string): string {
  const title = kit.trim() || "Order";
  const who = customer.trim() || "No customer";
  const id = orderKeyValue.startsWith("deal:") ? orderKeyValue.slice("deal:".length) : orderKeyValue;
  return `${title} \u2013 ${who} (${id})`.replace(/[\\/]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

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
  orderKeys: z.array(plateOrderKeySchema).max(20).optional(),
});

export const plateUploadQuerySchema = z.object({
  orderKey: plateOrderKeySchema,
  fileName: z.string().trim().min(1).max(240),
  printer: z.string().trim().max(40).optional().default(""),
  notes: z.string().trim().max(2000).optional().default(""),
  kit: z.string().trim().max(180).optional().default(""),
  customer: z.string().trim().max(120).optional().default(""),
});

export const plateFileBulkSchema = z.object({
  files: z.array(plateFileIndexSchema).min(1).max(100),
});

export const plateFileLinkSchema = z.object({
  driveFileId: z.string().trim().min(1).max(200),
  orderKey: plateOrderKeySchema,
});

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
  orderKeys: string[];
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
