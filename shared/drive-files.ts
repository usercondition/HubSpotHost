/** Business-only Google Drive file index (synced from the Mac mini's nightly drive_thumbs.py). */
export const DRIVE_FILE_CATEGORIES = ["model", "sliced", "archive", "photo", "video", "doc", "folder", "other"] as const;
export type DriveFileCategory = (typeof DRIVE_FILE_CATEGORIES)[number];
export type DriveThumbSource = "drive" | "folder-photo" | "render" | "web" | "icon";

export type DriveFileView = {
  id: string;
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
  total: number;
  offset: number;
  items: DriveFileView[];
  counts: Partial<Record<DriveFileCategory, number>>;
  generatedAt: string | null;
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

export function driveDownloadUrl(f: Pick<DriveFileView, "id" | "category">): string | null {
  if (f.category === "folder") return null;
  return `https://drive.google.com/uc?id=${encodeURIComponent(f.id)}&export=download`;
}

/** Lowercase AND-tokens; separators ignored ("dark-angels" == "dark angels"). */
export function queryTokens(q: string): string[] {
  return (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1).slice(0, 8);
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
