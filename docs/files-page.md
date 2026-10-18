# Files page (Drive + shop-drive search with thumbnails)

`#/files?q=<words>&cat=<category>&src=<drive|shop>`: mobile-first search over the shop's **business** files on Google Drive and on the shop JBOD drives (X:/Y:/Z:), behind the normal owner code. Hermes links here ("All results") from Telegram/iMessage file searches.

## Data path (push, no inbound route to the Mac mini)

1. Mac mini 03:00 `com.home.drive-inventory` lists Drive (read-only).
2. Mac mini 03:25 `com.home.drive-thumbs` (`~/.hermes/scripts/drive_thumbs.py`) builds `files_index.json` + a thumbnail cache. Personal / VA / medical / family / receipts / labels / client-chat folders are dropped there; client-job folder names become "Client job".
3. `~/.hermes/scripts/drive_files_sync.py` pushes rows and 256 px thumbnails here (only changed thumbs):
   - `GET/POST /api/ops/files/sync/thumbs`, `POST /api/ops/files/sync/rows`, `POST /api/ops/files/sync/commit`
   - `Authorization: Bearer $FILES_SYNC_TOKEN` (>= 24 chars). Unset = 503, so nothing can write until it's configured.
   - Commit drops rows not in the new generation; an empty push never wipes the index.
4. `GET /api/files?q=&cat=&offset=&limit=` (owner code) returns results with thumbnails inline as `data:` URLs, so there is no unauthenticated image route.

Storage: `drive-files.db` next to the other SQLite files on the `/data` volume (`DRIVE_FILES_DB_FILE` overrides). Expect ~60-80 MB for ~35k Drive rows and ~7k thumbnails; with the shop source (~44k rows + ~7.8k thumbnails after the first night) the local copy was ~265 MB including WAL.

## Search

- Text is normalized on both sides: case, `_ - . +`, camelCase and letter/digit boundaries become spaces
  (`S.P.R.U.E.+Ground+Plunderer`, `grimdark_ground_plunderer`, `HeavyIntercessors` all match plain words).
- Every query word must match (any order) somewhere in the name, folder path, tags or, for shop folders, the names of
  the files inside. Words match as substrings, so prefixes work (`plund side door`). Squashed name/path are indexed
  too, so `groundplunderer` and `mk2b` hit `Ground Plunderer Mk2B`.
- Index: SQLite FTS5 `trigram` table over the normalized text (the SQLite answer to Postgres pg_trgm); words under
  3 letters fall back to a word-start `LIKE`. ~5-25 ms over ~80k rows.
- Close matches: when fewer than 12 rows match exactly, each query word is widened with index words within edit
  distance 1 (5-8 letters) or 2 (9+), and joined words are split against the index vocabulary. Exact hits still rank
  first; the page says "Showing close spellings".
- Ranking: exact before close; whole name = query > name starts with query > name words start with query words >
  name contains them > folder path only; folders/kits > archives > models > sliced; real pictures first; newest.

## Shop drives (source `shop`)

`~/.hermes/scripts/shop_files_sync.py` on the Mac mini (copy in `script/mac_shop_files_sync.py`) reads the nightly JBOD list (`~/.drive-index/files.tsv`,
03:41 `com.home.drive-index`) and pushes one row per folder plus one per `.zip/.rar/.7z` (~31k folders + ~12.7k
archives; individual STLs are not rows, their names are search keywords on the folder). `._*`, `.DS_Store`,
`Thumbs.db`, `$RECYCLE.BIN` etc. are skipped. Every file goes through the same business-only filter as Drive
(`drive_thumbs.privacy` + Hermes' keep-root/OMF extras) **before** aggregation, and names/paths go through
`client_mask`. It fails closed if either module is missing, and it sends nothing until this server answers
`GET /api/ops/files/sync/sources` (older servers would drop `source`).

Thumbnails (256 px, cached and incremental): an image in the folder (preview/render/cover names preferred), else an
image inside the zip, else a small STL render (50 KB-6 MB, 25 s cap each), and kit folders inherit a child's/parent's
picture. Default budget 30 min per night (15 min reserved for STL renders); the cache fills in over a few nights.

Shop rows have no Drive link: the sheet shows the Windows path (`X:\Kit\Doors\`) with **Copy path**; open it on the PC
or ask Hermes (`drivefile.py fetch`). A Drive commit only replaces Drive rows and a shop commit only shop rows.

## Actions

Open in Drive (webViewLink), Download (`drive.google.com/uc?export=download`), Share link (native share sheet or copy). Print Ops never changes Drive sharing.

## Setup after merge (needs Miguel's OK)

Shop drives: after deploy, run `/usr/bin/python3 ~/.hermes/scripts/shop_files_sync.py --dry-run`, then once without `--dry-run`, then schedule it daily at 04:40 (after the 03:41 JBOD index and the 04:05 Drive sync; not concurrently with the Drive sync, whose commit prunes unreferenced thumbnails).


1. Railway: set `FILES_SYNC_TOKEN` (random, 32+ chars).
2. Mac mini: write the same value to `~/.hermes/secrets/print-ops-files-sync-token` (0600), run `/usr/bin/python3 ~/.hermes/scripts/drive_files_sync.py`, then schedule it after `com.home.drive-thumbs`.

Screenshots (local build, synced from a real business-only index subset): `docs/screenshots/files/` (08-10: shop drives + close spellings, from the real 34,986 Drive + 43,611 shop rows).
