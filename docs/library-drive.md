# Library <- Drive folder "Chitubox Sliced files"

Folder: `1MnLB0U8mm-rVrmtxposF-GWI3LJG6kui` (owner streetsofmerchant@gmail.com). Override with
`LIBRARY_DRIVE_FOLDER_ID` / `LIBRARY_DRIVE_FOLDER_NAME`. Print Ops never writes to this folder.

## Data flow

1. Nightly, the Mac mini's Files pipeline (drive_thumbs.py -> drive_files_sync.py, unchanged) pushes the
   business-only Drive index to `drive_files`. Rows are privacy-filtered and client-masked there.
2. `server/lib/library-drive.ts` picks the sliced plates under the folder (parent id, or folder path and its
   subfolders; `.stl/.3mf` stay on Files) and folds them into `plate_files`:
   * on Library open (`GET /api/plate-files`) when the index changed, at most once a minute otherwise;
   * every 30 minutes in the server (unref'd timer), so a new nightly index lands without opening Library;
   * on demand: `POST /api/plate-files/drive-sync` (Library refresh button);
   * right after a manual upload (so the upload absorbs its Drive twin immediately).
   No Drive API call is made: the server's token is `drive.file` and cannot read that folder anyway.
3. An extra display mask (`maskLibraryClientText`) hides known stack contact names and
   "pricing/quote/order/job for <Name>" in slicer file names, which sit in a product folder the Mac mask skips.

## One plate = one Library item

Match order: same Drive file id -> same slice fingerprint (sha256, when a pusher sends one) -> same catalog
file name + exact byte size. A match records the Drive file as a copy on the existing item
(`plate_file_drive_copies`); it never creates a second row. Different size = a re-slice = its own item.

* Manual metadata (printer, kit, notes, sliced stats/preview, order links) is never overwritten by Drive.
* Drive-only rows get Drive name/size/modified updates only when Drive's modified time is newer.
* A Drive-only row folds into an uploaded twin that appears later: order/print links move over, the Drive
  file becomes a copy, the Drive-only row is removed.
* Drive-only rows that leave the folder are dropped only if nothing links to them and the index still has the
  folder row (an empty or aborted push never wipes the Library). Linked rows stay, marked not-in-folder.
* Drive-only plates are links: no Download/Layers/3D/backfill/mesh (the server cannot read their bytes);
  their slicer stats appear once the same plate is uploaded from an order (then it merges).

## Dual path plan (PC auto-backup + manual uploads)

Not built yet; waiting for the ChituBox save folder name.

* PC (DESKTOP-1240REE): Google Drive for desktop "Backup/Sync folder" or a small scheduled copy job from the
  ChituBox save folder into `Chitubox Sliced files` (copy only, never delete/move). New files appear in the
  nightly index -> Library, deduped as above.
* Optional exact matching: the PC job can compute the Print Ops slice fingerprint (size + first/last 1 MiB +
  CTB header, `shared/slice-fingerprint`) and either push it with the existing owner `POST /api/plate-files`
  bulk index or write it into the Drive file's `appProperties`; the reconcile already matches by sha256 first.
* Manual uploads keep going to `Print Ops/Library/<kit>` (the app-created folder; `drive.file` scope cannot add
  files to a folder it did not create). To have one source of truth later, either (a) Miguel picks the
  Chitubox folder once through the Google Picker so the app gains access to it and uploads land there
  directly (then the upload and the Drive row share one file id: rule 1), or (b) a Mac job mirrors
  `Print Ops/Library/*` into the Chitubox folder (copy only); dedupe folds the mirror copy into the upload.
