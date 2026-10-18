# Files page (Drive search with thumbnails)

`#/files?q=<words>&cat=<category>`: mobile-first search over the shop's **business** Google Drive files, behind the normal owner code. Hermes links here ("All results") from Telegram/iMessage file searches.

## Data path (push, no inbound route to the Mac mini)

1. Mac mini 03:00 `com.home.drive-inventory` lists Drive (read-only).
2. Mac mini 03:25 `com.home.drive-thumbs` (`~/.hermes/scripts/drive_thumbs.py`) builds `files_index.json` + a thumbnail cache. Personal / VA / medical / family / receipts / labels / client-chat folders are dropped there; client-job folder names become "Client job".
3. `~/.hermes/scripts/drive_files_sync.py` pushes rows and 256 px thumbnails here (only changed thumbs):
   - `GET/POST /api/ops/files/sync/thumbs`, `POST /api/ops/files/sync/rows`, `POST /api/ops/files/sync/commit`
   - `Authorization: Bearer $FILES_SYNC_TOKEN` (>= 24 chars). Unset = 503, so nothing can write until it's configured.
   - Commit drops rows not in the new generation; an empty push never wipes the index.
4. `GET /api/files?q=&cat=&offset=&limit=` (owner code) returns results with thumbnails inline as `data:` URLs, so there is no unauthenticated image route.

Storage: `drive-files.db` next to the other SQLite files on the `/data` volume (`DRIVE_FILES_DB_FILE` overrides). Expect ~60-80 MB for ~35k rows and ~7k thumbnails.

## Actions

Open in Drive (webViewLink), Download (`drive.google.com/uc?export=download`), Share link (native share sheet or copy). Print Ops never changes Drive sharing.

## Setup after merge (needs Miguel's OK)

1. Railway: set `FILES_SYNC_TOKEN` (random, 32+ chars).
2. Mac mini: write the same value to `~/.hermes/secrets/print-ops-files-sync-token` (0600), run `/usr/bin/python3 ~/.hermes/scripts/drive_files_sync.py`, then schedule it after `com.home.drive-thumbs`.

Screenshots (local build, synced from a real business-only index subset): `docs/screenshots/files/`.
