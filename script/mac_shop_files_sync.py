#!/usr/bin/env python3
"""Shop drives (X:/Y:/Z: JBODs on the Mac mini) -> Print Ops Files page as source='shop'.  Scheduled 04:40 PT (com.home.shop-files-sync).

Needs the Print Ops server from the files-search PR: it probes GET /api/ops/files/sync/sources
and sends nothing when that route is missing (an older server would drop `source` and treat rows as Drive rows).

Source : ~/.drive-index/files.tsv (nightly 03:41 build-drive-index.sh; path<TAB>size<TAB>mtime<TAB>tag; no ._ files)
Rows   : one row per folder (recursive size/count, names of the files directly inside as search-only keywords,
         plus "entries": masked name + size of up to 300 files directly inside, for drilling into a kit)
         + one row per .zip/.rar/.7z archive. Individual STLs are not rows (the folder row carries their words).
Privacy: same business-only gate as Drive + Hermes drivefile.py (drive_thumbs.privacy + keep-root/OMF extras),
         applied to every file BEFORE aggregation, so private files never contribute names, sizes or previews.
         Client names masked with client_mask (display only; nothing on the drives is renamed). Fails closed.
Thumbs : 256 px JPEG, cached in ~/.hermes/data/drive_inventory/shop/thumbs, incremental via state.json:
         1) an image directly in the folder (preview/render/cover names preferred)  -> "folder-photo"
         2) an image inside a .zip (central directory only, first good entry)       -> "folder-photo"
         3) kit folders without a picture inherit a child's (<=2 levels) or the parent's picture
         4) STL render of a small STL (50 KB-6 MB), 25 s cap per file, --render-min total -> "render"
Read-only toward the drives. Never prints the sync token.

  /usr/bin/python3 shop_files_sync.py --dry-run             # build + report, send nothing
  /usr/bin/python3 shop_files_sync.py --export DIR          # write DIR/rows.json + DIR/thumbs (local testing)
  /usr/bin/python3 shop_files_sync.py                       # push (after the server PR is deployed)
"""
import argparse
import base64
import fcntl
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
TSV = os.environ.get("DRIVE_INDEX") or os.path.join(HOME, ".drive-index", "files.tsv")
OUT = os.path.join(HOME, ".hermes", "data", "drive_inventory", "shop")
THUMBS = os.path.join(OUT, "thumbs")
STATE = os.path.join(OUT, "state.json")
LOCK = os.path.join(OUT, ".lock")
TOKEN_FILE = os.path.join(HOME, ".hermes", "secrets", "print-ops-files-sync-token")
BASE = os.environ.get("PRINT_OPS_BASE", "https://hubspothost-production.up.railway.app")
MAX_BODY = 850_000
ENTRIES_MAX = 300  # per folder row; the server accepts up to 400
MAP = {"/Volumes/2BOBS EXPAN": "X:", "/Volumes/BOBS EXPANS": "Y:", "/Volumes/JBODS": "Z:"}
SKIP_NAME = re.compile(r"^(\._.*|\.DS_Store|Thumbs\.db|desktop\.ini|Icon\r?)$", re.I)
SKIP_SEG = re.compile(r"^(\$RECYCLE\.BIN|System Volume Information|\.Trashes|\.Spotlight-V100|\.fseventsd|\.TemporaryItems|__MACOSX)$", re.I)
PRIVATE_EXTRA = re.compile(r"(_keep-root-files|from c\)|\bomp?f\b)", re.I)  # same as drivefile.py
IMG_EXT = {"jpg", "jpeg", "png", "webp"}
ARCHIVE_EXT = {"zip", "rar", "7z"}
PREF_IMG = re.compile(r"(preview|render|cover|thumb|main|promo|front|box|banner|showcase)", re.I)
BAD_IMG = re.compile(r"(scale|size|chart|guide|instruction|logo|qr|support|layout|plate)", re.I)
TYPE_LABEL = [("stl", "STL", "STL"), ("lys", "LYS", "LYS"), ("chitubox", "sliced", "sliced"), ("archive", "archive", "archives"),
              ("image", "image", "images")]
STOP = {"stl", "lys", "obj", "the", "and", "for", "with", "supported", "presupported", "unsupported", "copy", "part",
        "parts", "file", "files", "jpg", "png", "zip"}


def log(m):
    print(f"shop-files-sync: {m}", flush=True)


def norm_words(s):
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s or "")
    return [w for w in re.split(r"[^a-z0-9]+", s.lower()) if len(w) >= 3 and not w.isdigit() and w not in STOP]


def ext(n):
    return os.path.splitext(n)[1].lower().lstrip(".")


def load_filters():
    sys.path.insert(0, os.path.join(HOME, ".hermes", "scripts"))
    try:
        from drive_thumbs import privacy
    except Exception as e:
        raise SystemExit(f"shop-files-sync: privacy filter unavailable ({type(e).__name__}); nothing built")
    try:
        from client_mask import mask_name, mask_path
    except Exception as e:
        raise SystemExit(f"shop-files-sync: client mask unavailable ({type(e).__name__}); nothing built")
    return privacy, mask_name, mask_path


def read_index(privacy):
    """-> list of (vol, rel, size, mtime, tag) for business files only."""
    kept, skipped_private, skipped_junk = [], 0, 0
    with open(TSV, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if len(f) < 4:
                continue
            path = f[0]
            vol = next((v for v in MAP if path.startswith(v + "/")), None)
            if not vol:
                continue
            rel = path[len(vol) + 1:]
            segs = rel.split("/")
            if SKIP_NAME.match(segs[-1]) or any(SKIP_SEG.match(s) for s in segs[:-1]):
                skipped_junk += 1
                continue
            if PRIVATE_EXTRA.search(rel) or not privacy(rel, segs[-1])[0]:
                skipped_private += 1
                continue
            try:
                kept.append((vol, rel, int(f[1]), int(f[2]), f[3]))
            except ValueError:
                continue
    return kept, skipped_private, skipped_junk


def aggregate(files):
    dirs, archives = {}, []
    for vol, rel, size, mt, tag in files:
        segs = rel.split("/")
        parent = "/".join(segs[:-1])
        if ext(segs[-1]) in ARCHIVE_EXT:
            archives.append((vol, rel, size, mt))
        for i in range(1, len(segs)):
            k = (vol, "/".join(segs[:i]))
            d = dirs.get(k)
            if d is None:
                d = dirs[k] = {"size": 0, "mtime": 0, "n": 0, "types": {}, "names": [], "images": [], "stls": [], "zips": [], "files": [], "children": set()}
            d["size"] += size
            d["mtime"] = max(d["mtime"], mt)
            d["n"] += 1
            d["types"][tag] = d["types"].get(tag, 0) + 1
            if i < len(segs) - 1:
                d["children"].add(segs[i])
        if parent:
            d = dirs[(vol, parent)]
            d["names"].append(segs[-1])
            d["files"].append((segs[-1], size))
            e = ext(segs[-1])
            if e in IMG_EXT and 8_000 < size < 12_000_000:
                d["images"].append((segs[-1], size))
            elif e == "stl" and 50_000 <= size <= 6_000_000:
                d["stls"].append((segs[-1], size))
            elif e == "zip":
                d["zips"].append((segs[-1], size, mt))
    return dirs, archives


def pick_image(cands):
    good = [c for c in cands if not BAD_IMG.search(c[0])] or cands
    good.sort(key=lambda c: (0 if PREF_IMG.search(c[0]) else 1, -min(c[1], 3_000_000), c[0].lower()))
    return good[0][0] if good else None


def small_jpeg(raw, dest, px=256):
    from PIL import Image

    im = Image.open(io.BytesIO(raw))
    im.draft("RGB", (px * 2, px * 2))
    im = im.convert("RGB")
    im.thumbnail((px, px))
    tmp = dest + ".tmp"
    im.save(tmp, "JPEG", quality=70, optimize=True)
    os.replace(tmp, dest)
    return True


def tkey(vol, rel):
    return "shop_" + hashlib.sha1(f"{vol}/{rel}".encode()).hexdigest()[:20] + ".jpg"


RENDER_CHILD = r"""
import sys, os
sys.path.insert(0, os.path.expanduser("~/.hermes/scripts"))
import drive_thumbs
drive_thumbs.THUMB_PX = 256
ok = drive_thumbs.render_stl(open(sys.argv[1], "rb").read(), sys.argv[2])
sys.exit(0 if ok else 3)
"""


def build_thumbs(dirs, archives, state, a):
    """-> ({(vol, rel_dir): (key, src)}, {(vol, rel_zip): (key, src)}, stats). Uses + updates state cache."""
    os.makedirs(THUMBS, exist_ok=True)
    cache = state.setdefault("thumbs", {})  # "<vol>/<rel>|<size>|<mtime>" -> [key, src] or ["", "fail"]
    t0 = time.time()
    t_end = t0 + a.budget_min * 60  # whole thumbnail run
    img_end = t0 + max(a.budget_min - max(a.render_min, 0), a.budget_min * 0.25) * 60  # STL renders keep their share
    stats = {"image": 0, "zip": 0, "render": 0, "cached": 0, "fail": 0, "budget_hit": False}
    folder_thumb, zip_thumb = {}, {}
    # launchd jobs may lack Full Disk Access to the JBODs: then reuse cached thumbnails only and never cache failures.
    readable = True
    for vol in MAP:
        try:
            os.listdir(vol)
        except OSError:
            readable = False
    stats["volumes_readable"] = readable

    def cached(ck):
        v = cache.get(ck)
        if v and (v[1] == "fail" or os.path.exists(os.path.join(THUMBS, v[0]))):
            stats["cached"] += 1
            return v
        return None

    def budget_ok(until=None):
        if not readable:
            return False
        if time.time() < (until or img_end) and len(cache) < a.max_thumbs * 2:
            return True
        stats["budget_hit"] = True
        return False

    # 1) folder images (shallow folders first so top-level kits get pictures first)
    for (vol, rel), d in sorted(dirs.items(), key=lambda kv: (kv[0][1].count("/"), kv[0][1].lower())):
        name = pick_image(d["images"])
        if not name:
            continue
        img_rel = f"{rel}/{name}"
        size = next(s for n, s in d["images"] if n == name)
        ck = f"{vol}/{img_rel}|{size}"
        v = cached(ck)
        if v is None:
            if not budget_ok():
                continue
            key = tkey(vol, img_rel)
            try:
                with open(f"{vol}/{img_rel}", "rb") as fh:
                    small_jpeg(fh.read(), os.path.join(THUMBS, key))
                v = cache[ck] = [key, "folder-photo"]
                stats["image"] += 1
            except PermissionError:
                continue
            except Exception:
                v = cache[ck] = ["", "fail"]
                stats["fail"] += 1
        if v[1] != "fail":
            folder_thumb[(vol, rel)] = (v[0], v[1])

    # 2) images inside zips (zip rows; and the folder when it has no picture of its own)
    for vol, rel, size, mt in archives:
        if ext(rel) != "zip":
            continue
        ck = f"{vol}/{rel}|{size}|{mt}"
        v = cached(ck)
        if v is None:
            if not budget_ok():
                continue
            v = ["", "fail"]
            try:
                with zipfile.ZipFile(f"{vol}/{rel}") as z:
                    ents = [i for i in z.infolist() if ext(i.filename) in IMG_EXT and 8_000 < i.file_size < 12_000_000
                            and "__MACOSX" not in i.filename and not os.path.basename(i.filename).startswith("._")]
                    name = pick_image([(i.filename, i.file_size) for i in ents])
                    if name:
                        key = tkey(vol, rel)
                        small_jpeg(z.read(name), os.path.join(THUMBS, key))
                        v = [key, "folder-photo"]
                        stats["zip"] += 1
            except PermissionError:
                continue
            except Exception:
                stats["fail"] += 1
            cache[ck] = v
        if v[1] != "fail":
            zip_thumb[(vol, rel)] = (v[0], v[1])
            parent = (vol, rel.rsplit("/", 1)[0]) if "/" in rel else None
            if parent and parent not in folder_thumb:
                folder_thumb[parent] = (v[0], v[1])

    # 3) STL renders for folders that hold STLs but still have no picture (time-capped, cached incl. failures)
    r_end = t_end
    for (vol, rel), d in sorted(dirs.items(), key=lambda kv: (kv[0][1].count("/"), kv[0][1].lower())):
        if (vol, rel) in folder_thumb or not d["stls"] or a.render_min <= 0:
            continue
        name, size = sorted(d["stls"], key=lambda c: (abs(c[1] - 1_500_000), c[0]))[0]
        stl_rel = f"{rel}/{name}"
        ck = f"{vol}/{stl_rel}|{size}"
        v = cached(ck)
        if v is None:
            if not budget_ok(r_end):
                stats["budget_hit"] = True
                continue
            key = tkey(vol, stl_rel)
            try:
                p = subprocess.run([sys.executable, "-c", RENDER_CHILD, f"{vol}/{stl_rel}", os.path.join(THUMBS, key)],
                                   capture_output=True, timeout=25)
                ok = p.returncode == 0 and os.path.exists(os.path.join(THUMBS, key))
            except subprocess.TimeoutExpired:
                ok = False
            v = cache[ck] = [key, "render"] if ok else ["", "fail"]
            stats["render" if ok else "fail"] += 1
        if v[1] != "fail":
            folder_thumb[(vol, rel)] = (v[0], v[1])

    # 4) inherit: kit parent <- first child with a picture (2 levels); subfolder ("Supported", "Doors") <- parent
    for depth_pass in range(2):
        for (vol, rel), d in sorted(dirs.items(), key=lambda kv: -kv[0][1].count("/")):
            if (vol, rel) in folder_thumb:
                continue
            for c in sorted(d["children"]):
                t = folder_thumb.get((vol, f"{rel}/{c}"))
                if t:
                    folder_thumb[(vol, rel)] = t
                    break
    for (vol, rel) in sorted(dirs, key=lambda k: k[1].count("/")):
        if (vol, rel) not in folder_thumb and "/" in rel:
            t = folder_thumb.get((vol, rel.rsplit("/", 1)[0]))
            if t:
                folder_thumb[(vol, rel)] = t
    # zips without their own picture use the folder's picture (sibling image = kit photo)
    for vol, rel, size, mt in archives:
        if (vol, rel) not in zip_thumb and "/" in rel:
            t = folder_thumb.get((vol, rel.rsplit("/", 1)[0]))
            if t:
                zip_thumb[(vol, rel)] = t
    return folder_thumb, zip_thumb, stats


def types_label(t):
    parts = [f"{t[k]:,} {one if t[k] == 1 else many}" for k, one, many in TYPE_LABEL if t.get(k)]
    return " · ".join(parts)[:80]


def make_rows(dirs, archives, folder_thumb, zip_thumb, mask_name, mask_path):
    rows = []
    iso = lambda mt: datetime.fromtimestamp(mt, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if mt else None
    for (vol, rel), d in dirs.items():
        masked = mask_path(rel).split("/")
        letter = MAP[vol]
        name = masked[-1]
        path = "/".join([letter] + masked[:-1])
        own = set(norm_words(rel))
        kw, seen = [], set()
        for n in d["names"]:
            for w in norm_words(mask_name(n, rel, False)):
                if w not in own and w not in seen:
                    seen.add(w)
                    kw.append(w)
        t = folder_thumb.get((vol, rel))
        rows.append({
            "id": "sd_" + hashlib.sha1(f"{vol}/{rel}/".encode()).hexdigest()[:24], "source": "shop",
            "name": name[:400], "category": "folder", "path": path[:1200], "parent": None,
            "size": d["size"], "modifiedTime": iso(d["mtime"]), "webViewLink": None, "mimeType": None,
            "tags": {k: v for k, v in {"drive": letter, "files": f"{d['n']:,} files", "types": types_label(d["types"])}.items() if v},
            "thumbSource": t[1] if t else "icon", "thumbKey": t[0] if t else None, "webSourceUrl": None,
            "keywords": " ".join(kw)[:1990],
            # Files directly inside (masked names) so the Files page can drill a kit down to files. Display only.
            "entries": [{"n": mask_name(n, rel, False)[:300], "s": s}
                        for n, s in sorted(d["files"], key=lambda x: x[0].lower())[:ENTRIES_MAX]],
        })
    for vol, rel, size, mt in archives:
        segs = rel.split("/")
        parent = "/".join(segs[:-1])
        masked_parent = mask_path(parent) if parent else ""
        t = zip_thumb.get((vol, rel))
        rows.append({
            "id": "sd_" + hashlib.sha1(f"{vol}/{rel}".encode()).hexdigest()[:24], "source": "shop",
            "name": mask_name(segs[-1], parent, False)[:400], "category": "archive",
            "path": "/".join([MAP[vol]] + ([masked_parent] if masked_parent else []))[:1200], "parent": None,
            "size": size, "modifiedTime": iso(mt), "webViewLink": None, "mimeType": None, "tags": {"drive": MAP[vol]},
            "thumbSource": t[1] if t else "icon", "thumbKey": t[0] if t else None, "webSourceUrl": None, "keywords": "",
        })
    return rows


def call(path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method="POST" if data else "GET",
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json",
                                          "User-Agent": "shop-files-sync/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404, 503):
                raise SystemExit(f"Print Ops answered {e.code} on {path}: {e.read()[:200]!r}")
            time.sleep(3 * (attempt + 1))
        except urllib.error.URLError:
            time.sleep(3 * (attempt + 1))
    raise SystemExit(f"Print Ops unreachable on {path}")


def batches(items, size_of, max_count):
    cur, n = [], 2
    for it in items:
        s = size_of(it) + 1
        if cur and (n + s > MAX_BODY or len(cur) >= max_count):
            yield cur
            cur, n = [], 2
        cur.append(it)
        n += s
    if cur:
        yield cur


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--export", metavar="DIR")
    ap.add_argument("--no-thumbs", action="store_true")
    ap.add_argument("--budget-min", type=float, default=30, help="total thumbnail work per run (minutes)")
    ap.add_argument("--render-min", type=float, default=15, help="STL render share of the budget (minutes)")
    ap.add_argument("--max-thumbs", type=int, default=9000)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("another run holds the lock; exiting")
        return 0
    if not os.path.exists(TSV) or os.path.getsize(TSV) == 0:
        log("no drive index; nothing built")
        return 0
    privacy, mask_name, mask_path = load_filters()
    t0 = time.time()
    files, skipped_private, skipped_junk = read_index(privacy)
    dirs, archives = aggregate(files)
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}
    if a.no_thumbs:
        folder_thumb, zip_thumb, stats = {}, {}, {}
    else:
        folder_thumb, zip_thumb, stats = build_thumbs(dirs, archives, state, a)
        tmp = STATE + ".tmp"
        json.dump(state, open(tmp, "w"))
        os.replace(tmp, STATE)
    rows = make_rows(dirs, archives, folder_thumb, zip_thumb, mask_name, mask_path)
    keys = {r["thumbKey"] for r in rows if r["thumbKey"]}
    gen = "s" + datetime.fromtimestamp(os.path.getmtime(TSV)).strftime("%Y%m%d%H%M%S")
    generated_at = datetime.fromtimestamp(os.path.getmtime(TSV), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    log(f"gen={gen} files={len(files)} skipped_private={skipped_private} skipped_junk={skipped_junk} folders={len(dirs)} "
        f"archives={len(archives)} rows={len(rows)} thumbs={len(keys)} stats={stats} {time.time() - t0:.0f}s")
    if a.export:
        os.makedirs(os.path.join(a.export, "thumbs"), exist_ok=True)
        for k in keys:
            shutil.copy2(os.path.join(THUMBS, k), os.path.join(a.export, "thumbs", k))
        json.dump({"generation": gen, "generatedAt": generated_at, "rows": rows}, open(os.path.join(a.export, "rows.json"), "w"))
        log(f"exported to {a.export}")
    if a.dry_run or a.export:
        return 0
    if not os.path.exists(TOKEN_FILE):
        log("not configured (no token file); nothing sent")
        return 0
    token = open(TOKEN_FILE).read().strip()
    try:
        call("/api/ops/files/sync/sources", token)
    except SystemExit as e:
        log(f"server has no shop-drive support yet ({str(e)[:60]}); nothing sent")
        return 0
    have = call("/api/ops/files/sync/thumbs", token).get("keys", {})
    todo = []
    for k in sorted(keys):
        raw = open(os.path.join(THUMBS, k), "rb").read()
        sha = hashlib.sha1(raw).hexdigest()[:16]
        if have.get(k) != sha:
            todo.append({"key": k, "sha": sha, "mime": "image/jpeg", "data": base64.b64encode(raw).decode()})
    sent = sum(call("/api/ops/files/sync/thumbs", token, {"thumbs": b}).get("stored", 0)
               for b in batches(todo, lambda t: len(t["data"]) + 120, 200))
    up = sum(call("/api/ops/files/sync/rows", token, {"generation": gen, "rows": b}).get("upserted", 0)
             for b in batches(rows, lambda r: len(json.dumps(r)), 5000))
    res = call("/api/ops/files/sync/commit", token, {"generation": gen, "generatedAt": generated_at, "source": "shop"})
    log(f"thumbs stored={sent} rows upserted={up} commit={res}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
