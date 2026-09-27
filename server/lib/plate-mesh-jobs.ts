/**
 * Mesh jobs run off the upload and backfill requests.
 * A plate already marked ready is left alone. A crash mid-job stays retryable.
 */
import { Readable } from "node:stream";
import { libraryFolderName, librarySliceName } from "../../shared/plate-files";
import { ensureLibraryFolder, openDriveMedia, uploadDriveFile } from "./google-drive";
import { getPlateFile, listPlateIdsNeedingMesh, markPlateMesh } from "./plate-files";
import { plateMeshEpoch, registerPlateMeshGate } from "./plate-mesh-gate";
import { buildPlateGlb } from "./plate-mesh";

const pending = new Set<string>();
const running = new Set<string>();
registerPlateMeshGate(() => pending.clear());
let draining = false;
const idleWaiters: Array<() => void> = [];

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

async function generateOne(driveFileId: string, epoch: number): Promise<void> {
  const live = () => plateMeshEpoch() === epoch;
  const file = getPlateFile(driveFileId);
  if (!live() || !file || file.meshState === "ready" || !/\.ctb$/i.test(file.name)) return;
  const size = file.sizeBytes ?? 0;
  if (size < 1) {
    markPlateMesh(driveFileId, { meshState: "ready", meshDriveFileId: "" });
    return;
  }
  markPlateMesh(driveFileId, { meshState: "preparing", meshDriveFileId: "" });
  const glb = await buildPlateGlb((start, length) => readPlateRange(file.driveFileId, start, length), size);
  if (!live()) return;
  if (glb.length < 20) {
    markPlateMesh(driveFileId, { meshState: "ready", meshDriveFileId: "" });
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
  markPlateMesh(driveFileId, { meshState: "ready", meshDriveFileId: uploaded.id });
}

async function drain(): Promise<void> {
  try {
    while (pending.size > 0) {
      const id = pending.values().next().value;
      if (!id) break;
      pending.delete(id);
      running.add(id);
      const epoch = plateMeshEpoch();
      try {
        await generateOne(id, epoch);
      } catch (error) {
        if (plateMeshEpoch() !== epoch) continue;
        const message = error instanceof Error ? error.message : "mesh failed";
        console.error("[plate-mesh]", id, message);
        markPlateMesh(id, { meshState: "" });
      } finally {
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
  if (!file || !/\.ctb$/i.test(file.name) || file.meshState === "ready") return false;
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
