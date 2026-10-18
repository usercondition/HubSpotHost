/**
 * Shop-drive kit grouping (X:/Y:/Z:). The sync pushes one row per folder; a kit such as "Ragegutta Mega Armor" has a
 * row for every part subfolder (Supported/Body, Unsupported/LeftArm, ...). The Files grid shows one card per kit:
 *
 * Kit root  = the shallowest folder on the row's path that looks like a single model kit: at most KIT_MAX_FILES files
 *             and KIT_MAX_CHILDREN subfolders, and not a "library" (many subfolders, none of them part-like).
 *             Big container folders ("BTDLS/FOLDER2/Knights") are skipped and the kit is found further down.
 * Copies    = kit roots whose names match after stripping copy markers (" (2)", " - Copy", "Copy of ") and whose
 *             total sizes agree within 1%, or kit roots with identical size + file count (> 5 MB), on any drive.
 *             A top-level .zip whose name matches a kit is listed as a copy of that kit. Nothing is deleted.
 * Pure functions so the server and tests share them.
 */

export const KIT_MAX_FILES = 1500;
export const KIT_MAX_CHILDREN = 40;
const PART_LIKE =
  /^(pre-?supported|un-?supported|supported|support|stl|stls|lys|lychee|chitubox|ctb|parts?|bits|body|bodies|base|bases|heads?|arms?|legs?|torso|weapons?|armou?r|backpacks?|options?|extras?|accessories|pictures?|images?|renders?|previews?|old|scene|lychee scene|files|split|whole|full|\d+mm|\d+ ?scale)$/i;

export type KitInputRow = { id: string; name: string; category: string; path: string; size: number | null; files: number | null };
export type KitAssignment = { kit: string; grp: string; copies: number; parts: number; creator: string | null };

/** A-Z key: leading punctuation/numbering ignored ("# Modern GrimDark" sorts under M). */
export function sortKey(name: string): string {
  return name.replace(/^[^A-Za-z0-9]+/, "").replace(/^\d{1,3}\s*[-.)]\s+/, "").toLowerCase() || name.toLowerCase();
}

/** "Knight Castellan @STLHammer" -> "STLHammer"; "Tank [by Foo Miniatures]" -> "Foo Miniatures". */
export function creatorOf(name: string): string | null {
  name = name.replace(/\.(zip|rar|7z|stl|lys)$/i, "");
  const at = name.match(/@\s*([A-Za-z0-9][\w.&'-]{1,40})/);
  if (at) return at[1].replace(/[._-]+$/, "");
  const by = name.match(/[\[(]\s*by\s+([^\])]{2,40})[\])]/i) ?? name.match(/\s-\s*by\s+(.{2,40})$/i);
  return by ? by[1].trim() : null;
}

/** Junk / system entries that must never show (the Mac sync skips them too; this guards old rows). */
export const JUNK_NAME = /^(\._.*|\.DS_Store|Thumbs\.db|desktop\.ini|Icon\r?|\$RECYCLE\.BIN|System Volume Information|\.Trashes|\.Spotlight-V100|\.fseventsd|\.TemporaryItems|__MACOSX|\.AppleDouble|\.apdisk)$/i;

/** "Knight Castellan (2)" / "Knight Castellan - Copy" / "Copy of Knight Castellan.zip" -> "knight castellan". */
export function copyKey(name: string): string {
  let s = name.trim().replace(/\.(zip|rar|7z)$/i, "");
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/\s*\((\d+|copy)\)\s*$/i, "")
      .replace(/\s*[-_]\s*copy(\s*\(?\d+\)?)?\s*$/i, "")
      .replace(/\s+copy(\s*\d+)?\s*$/i, "")
      .replace(/^copy of\s+/i, "")
      .trim();
  }
  return s.toLowerCase().replace(/[_\s]+/g, " ");
}

export function isPartLike(name: string): boolean {
  return PART_LIKE.test(name.trim().replace(/[_]+/g, " "));
}

/** Sort for an opened kit/folder: Supported/Unsupported first, then other folders, then by name. */
export function partOrder(name: string): number {
  const n = name.toLowerCase().replace(/[^a-z]/g, "");
  if (n === "supported" || n === "presupported") return 0;
  if (n === "unsupported") return 1;
  return 2;
}

export function parseFileCount(tag: string | undefined | null): number | null {
  if (!tag) return null;
  const m = tag.replace(/,/g, "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

const full = (r: { path: string; name: string }) => (r.path ? `${r.path}/${r.name}` : r.name);

/** Assign each shop row its kit root id and its card group id (the canonical copy of that kit). */
export function assignKits(rows: KitInputRow[]): Map<string, KitAssignment> {
  const folders = new Map<string, KitInputRow>();
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (r.category !== "folder") continue;
    folders.set(full(r), r);
    const arr = children.get(r.path) ?? [];
    arr.push(r.name);
    children.set(r.path, arr);
  }
  const kitLike = new Map<string, boolean>();
  const isKitLike = (fp: string): boolean => {
    const hit = kitLike.get(fp);
    if (hit !== undefined) return hit;
    const f = folders.get(fp);
    const kids = children.get(fp) ?? [];
    let ok = !!f && (f.files ?? 0) <= KIT_MAX_FILES && kids.length <= KIT_MAX_CHILDREN;
    if (ok && kids.length >= 8 && !kids.some(isPartLike)) ok = false; // a library of kits, not one kit
    kitLike.set(fp, ok);
    return ok;
  };
  const kitOf = new Map<string, string>(); // folder full path -> kit root full path
  const rootFor = (fp: string): string => {
    const c = kitOf.get(fp);
    if (c) return c;
    const segs = fp.split("/"); // ["X:", "A", "B", ...]
    let root = fp;
    for (let i = 2; i <= segs.length; i++) {
      const anc = segs.slice(0, i).join("/");
      if (folders.has(anc) && isKitLike(anc)) {
        root = anc;
        break;
      }
    }
    kitOf.set(fp, root);
    return root;
  };

  const out = new Map<string, KitAssignment>();
  const kitIdByPath = (fp: string, fallback: string) => folders.get(fp)?.id ?? fallback;
  for (const r of rows) {
    const base = { grp: "", copies: 1, parts: 0, creator: null };
    if (r.category === "folder") out.set(r.id, { ...base, kit: kitIdByPath(rootFor(full(r)), r.id) });
    else if (folders.has(r.path)) out.set(r.id, { ...base, kit: kitIdByPath(rootFor(r.path), r.id) });
    else out.set(r.id, { ...base, kit: r.id }); // top-level archive / loose file
  }

  // Copies among kit roots.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const roots = [...new Set([...out.values()].map((a) => a.kit))].map((id) => byId.get(id)!).filter(Boolean);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    parent.set(x, p);
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const folderRoots = roots.filter((r) => r.category === "folder");
  const byKey = new Map<string, KitInputRow[]>();
  for (const r of folderRoots) {
    const k = copyKey(r.name);
    if (!k) continue;
    const arr = byKey.get(k) ?? [];
    arr.push(r);
    byKey.set(k, arr);
  }
  const close = (a: number | null, b: number | null) => !!a && !!b && Math.abs(a - b) <= Math.max(a, b) * 0.01;
  for (const arr of byKey.values())
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) if (close(arr[i].size, arr[j].size)) union(arr[i].id, arr[j].id);
  const bySig = new Map<string, string>();
  for (const r of folderRoots) {
    if (!r.size || r.size < 5_000_000 || !r.files) continue;
    const sig = `${r.size}|${r.files}`;
    const o = bySig.get(sig);
    if (o) union(o, r.id);
    else bySig.set(sig, r.id);
  }
  // Top-level archives named like a kit join that kit's card.
  for (const r of roots) {
    if (r.category === "folder") continue;
    const arr = byKey.get(copyKey(r.name));
    if (arr?.length) union(arr[0].id, r.id);
  }
  // Canonical copy: a folder before an archive, then the plainest name (no copy marker), then shortest path, X: < Y: < Z:.
  const groups = new Map<string, KitInputRow[]>();
  for (const r of roots) {
    const g = find(r.id);
    const arr = groups.get(g) ?? [];
    arr.push(r);
    groups.set(g, arr);
  }
  const canon = new Map<string, { id: string; n: number }>();
  for (const arr of groups.values()) {
    arr.sort(
      (a, b) =>
        Number(a.category !== "folder") - Number(b.category !== "folder") ||
        Number(copyKey(a.name) !== a.name.trim().toLowerCase().replace(/[_\s]+/g, " ")) -
          Number(copyKey(b.name) !== b.name.trim().toLowerCase().replace(/[_\s]+/g, " ")) ||
        a.path.split("/").length - b.path.split("/").length ||
        full(a).localeCompare(full(b)),
    );
    for (const r of arr) canon.set(r.id, { id: arr[0].id, n: arr.length });
  }
  // Parts = leaf folders inside the kit (Supported/Body, Unsupported/LeftArm, ...); a flat kit counts as 1.
  const leaves = new Map<string, number>();
  for (const r of rows) {
    if (r.category !== "folder" || (children.get(full(r)) ?? []).length) continue;
    const k = out.get(r.id)!.kit;
    if (k !== r.id) leaves.set(k, (leaves.get(k) ?? 0) + 1);
  }
  for (const [id, a] of out) {
    const c = canon.get(a.kit) ?? { id: a.kit, n: 1 };
    a.grp = c.id;
    a.copies = c.n;
    if (a.kit === id) {
      const r = byId.get(id)!;
      a.parts = r.category === "folder" ? Math.max(1, leaves.get(id) ?? 0) : 0;
      a.creator = creatorOf(r.name) ?? creatorOf(r.path.split("/").slice(1).join(" "));
    }
  }
  return out;
}
