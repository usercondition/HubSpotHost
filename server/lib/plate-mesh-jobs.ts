/**
 * Mesh jobs run off the upload and backfill requests.
 * A plate already marked ready is left alone. Failed jobs stay visible and retryable.
 */
import { Readable } from "node:stream";
import { libraryFolderName, librarySliceName } from "../../shared/plate-files";
import { ensureLibraryFolder, openDriveMedia, trashDriveFile, uploadDriveFile } from "./google-drive";
import { getPlateFile, listPlateIdsNeedingMesh, markPlateMesh } from "./plate-files";
import { plateMeshEpoch, registerPlateMeshGate } from "./plate-mesh-gate";
import { PLATE_MESH_VERSION, buildPlateGlb, plateFootprint } from "./plate-mesh";
import { stlPlateGlb } from "./stl-plate-mesh";

/** One plate at a time. A 480MB decode must not overlap another. */
const MESH_JOB_CONCURRENCY = 1;
const MAX_STL_BYTES = 80 * 1024 * 1024;
const pending = new Set<string>();
const running = new Set<string>();
registerPlateMeshGate(() => pending.clear());
let draining = false;
let activeJobs = 0;
let peakJobs = 0;
const idleWaiters: Array<() => void> = [];

export function plateMeshJobPeak(): number {
  return peakJobs;
}

export function resetPlateMeshJobPeak(): void {
  peakJobs = 0;
}

function settleIdle(): void {
  if (draining || pending.size > 0 || running.size > 0) return;
  const waiters = idleWaiters.splice(0);
  for (const waiter of waiters) waiter();
}

export function whenPlateMeshesIdle(): Promise<void> {
  if (!draining && pending.size === 0 && running.size === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

async function readPlateRange(fileId: string, start: number, length: number): Promise<Buffer | null> {
  if (length < 1) return Buffer.alloc(0);
  const { takeResponseBytes } = await import("./plate-routes");
  const upstream = await openDriveMedia(fileId, `bytes=${start}-${start + length - 1}`);
  if (!upstream.ok && upstream.status !== 206) return null;
  const bytes = await takeResponseBytes(upstream, length);
  return bytes.length > 0 ? bytes : null;
}

function meshCurrent(file: { meshState: string; meshVersion: number }): boolean {
  return file.meshState === "ready" && file.meshVersion >= PLATE_MESH_VERSION;
}

async function retireMesh(previousId: string, nextId: string): Promise<void> {
  if (!previousId || previousId === nextId) return;
  try {
    await trashDriveFile(previousId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "trash failed";
    console.error("[plate-mesh] kept the previous GLB", previousId, message);
  }
}

async function generateOne(driveFileId: string, epoch: number): Promise<void> {
  const live = () => plateMeshEpoch() === epoch;
  const file = getPlateFile(driveFileId);
  if (!live() || !file || meshCurrent(file) || !/\.ctb$/i.test(file.name)) return;
  const previousId = file.meshDriveFileId;
  const size = file.sizeBytes ?? 0;
  if (size < 1) {
    markPlateMesh(driveFileId, { meshState: "ready", meshDriveFileId: "", meshVersion: PLATE_MESH_VERSION });
    await retireMesh(previousId, "");
    return;
  }
  markPlateMesh(driveFileId, { meshState: "preparing" });
  const ctbRange = (start: number, length: number) => readPlateRange(file.driveFileId, start, length);
  let glb: Buffer;
  if (file.stlDriveFileId) {
    const upstream = await openDriveMedia(file.stlDriveFileId, `bytes=0-${MAX_STL_BYTES - 1}`);
    if (!upstream.ok && upstream.status !== 206) throw new Error("Drive could not read the attached STL.");
    const stl = await (await import("./plate-routes")).takeResponseBytes(upstream, MAX_STL_BYTES);
    const footprint = await plateFootprint(ctbRange, size);
    glb = stlPlateGlb(stl, footprint);
  } else {
    glb = await buildPlateGlb(ctbRange, size);
  }
  if (!live()) return;
  if (glb.length < 20) {
    markPlateMesh(driveFileId, { meshState: "ready", meshDriveFileId: "", meshVersion: PLATE_MESH_VERSION });
    await retireMesh(previousId, "");
    return;
  }
  const folder = await ensureLibraryFolder(libraryFolderName(file.kit || "Kit"));
  const name = librarySliceName(file.name.replace(/\.ctb$/i, ".glb"), "");
  const uploaded = await uploadDriveFile({
    access: folder.access,
    folderId: folder.folderId,
    name,
    size: glb.length,
    body: Readable.from(glb),
  });
  if (!uploaded.id) throw new Error("Drive did not confirm the mesh.");
  markPlateMesh(driveFileId, { meshState: "ready", meshDriveFileId: uploaded.id, meshVersion: PLATE_MESH_VERSION });
  await retireMesh(previousId, uploaded.id);
}

async function drain(): Promise<void> {
  try {
    while (pending.size > 0) {
      const id = pending.values().next().value;
      if (!id) break;
      pending.delete(id);
      running.add(id);
      activeJobs += 1;
      peakJobs = Math.max(peakJobs, activeJobs);
      const epoch = plateMeshEpoch();
      try {
        if (activeJobs > MESH_JOB_CONCURRENCY) throw new Error("Only one mesh job runs at a time");
        await generateOne(id, epoch);
      } catch (error) {
        if (plateMeshEpoch() !== epoch) continue;
        const message = error instanceof Error ? error.message : "mesh failed";
        console.error("[plate-mesh]", id, message);
        markPlateMesh(id, { meshState: "failed" });
      } finally {
        activeJobs -= 1;
        running.delete(id);
      }
    }
  } finally {
    draining = false;
    if (pending.size > 0) {
      draining = true;
      setImmediate(() => {
        void drain();
      });
      return;
    }
    settleIdle();
  }
}

export function enqueuePlateMesh(driveFileId: string): boolean {
  const id = driveFileId.trim();
  if (!id || pending.has(id) || running.has(id)) return false;
  const file = getPlateFile(id);
  if (!file || !/\.ctb$/i.test(file.name) || meshCurrent(file)) return false;
  pending.add(id);
  if (!draining) {
    draining = true;
    setImmediate(() => {
      void drain();
    });
  }
  return true;
}

export function enqueueMissingPlateMeshes(): number {
  let count = 0;
  for (const id of listPlateIdsNeedingMesh()) {
    if (enqueuePlateMesh(id)) count += 1;
  }
  return count;
}
