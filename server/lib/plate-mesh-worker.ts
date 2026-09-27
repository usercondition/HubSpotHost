/**
 * Surface nets, smoothing, decimation, and GLB encode run here so the server
 * event loop can keep serving /api/health while a plate rebuilds.
 */
import { parentPort } from "node:worker_threads";
import { glbFromSurface, meshSurface, occupancyFromChunks, type MeshScale } from "./plate-mesh-surface";

interface MeshJob {
  keys: Float64Array;
  chunks: Uint32Array[];
  scale: MeshScale;
  gx: number;
  gy: number;
  gz: number;
  plateMmX: number;
  plateMmY: number;
  budget: number;
}

parentPort?.once("message", (job: MeshJob) => {
  try {
    const surface = meshSurface(occupancyFromChunks(job.keys, job.chunks), job.scale, job.gx, job.gy, job.gz, job.budget);
    if (!surface) {
      parentPort?.postMessage(new Uint8Array(0));
      return;
    }
    const glb = glbFromSurface(job.plateMmX, job.plateMmY, surface);
    const bytes = new Uint8Array(glb.byteLength);
    bytes.set(glb);
    parentPort?.postMessage(bytes, [bytes.buffer]);
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
