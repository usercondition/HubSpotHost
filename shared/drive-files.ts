/** Business-only file index: Google Drive (drive_thumbs.py) + shop JBOD drives X:/Y:/Z: (shop_files_sync.py). */
import { searchTokens } from "./file-search";

export const DRIVE_FILE_SOURCES = ["drive", "shop"] as const;
export type DriveFileSource = (typeof DRIVE_FILE_SOURCES)[number];
export const DRIVE_SOURCE_LABEL: Record<DriveFileSource, string> = { drive: "Google Drive", shop: "Shop drive" };
export const DRIVE_FILE_CATEGORIES = ["model", "sliced", "archive", "photo", "video", "doc", "folder", "other"] as const;
export type DriveFileCategory = (typeof DRIVE_FILE_CATEGORIES)[number];
export type DriveThumbSource = "drive" | "folder-photo" | "render" | "web" | "icon";

export type DriveFileView = {
  id: string;
  source: DriveFileSource;
  name: string;
  category: DriveFileCategory;
  path: string;
  size: number | null;
  modifiedTime: string | null;
  webViewLink: string | null;
  mimeType: string | null;
  tags: Record<string, string>;
  thumbSource: DriveThumbSource;
  /** data: URL (JPEG/PNG) or null when only the category icon is available. */
  thumb: string | null;
  webSourceUrl: string | null;
};

export type DriveFilesResponse = {
  ok: true;
  q: string;
  category: DriveFileCategory | null;
  source: DriveFileSource | null;
  total: number;
  /** Hits matching every word exactly (substring/prefix). When fewer than a dozen, close matches are added. */
  exactTotal: number;
  /** True when typo / joined-word matches were added (ranked after exact ones). */
  fuzzy: boolean;
  offset: number;
  items: DriveFileView[];
  counts: Partial<Record<DriveFileCategory, number>>;
  sources: Partial<Record<DriveFileSource, number>>;
  generatedAt: string | null;
  generatedAtShop: string | null;
  configured: boolean;
};

export const DRIVE_CATEGORY_LABEL: Record<DriveFileCategory, string> = {
  model: "STL / 3D",
  sliced: "Sliced",
  archive: "Archives",
  photo: "Photos",
  video: "Video",
  doc: "Docs",
  folder: "Folders",
  other: "Other",
};

/** Singular label for one file's details ("Folder", not "Folders"). */
export const DRIVE_CATEGORY_ONE: Record<DriveFileCategory, string> = {
  model: "STL / 3D",
  sliced: "Sliced file",
  archive: "Archive",
  photo: "Photo",
  video: "Video",
  doc: "Doc",
  folder: "Folder",
  other: "File",
};

export function driveDownloadUrl(f: Pick<DriveFileView, "id" | "category"> & { source?: DriveFileSource }): string | null {
  if (f.category === "folder" || f.source === "shop") return null;
  return `https://drive.google.com/uc?id=${encodeURIComponent(f.id)}&export=download`;
}

/** Lowercase AND-tokens; separators and camelCase ignored ("dark-angels" == "dark angels" == "DarkAngels"). */
export function queryTokens(q: string): string[] {
  return searchTokens(q);
}

/** Windows path of a shop-drive row as Miguel sees it on the PC: "X:/Kit/Doors" + name -> X:\Kit\Doors\name. */
export function shopWindowsPath(f: Pick<DriveFileView, "path" | "name" | "category">): string {
  const p = (f.path || "").replace(/\//g, "\\");
  const full = p ? `${p}\\${f.name}` : f.name;
  return f.category === "folder" ? `${full}\\` : full;
}

export function humanSize(n: number | null | undefined): string {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i < 2 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
