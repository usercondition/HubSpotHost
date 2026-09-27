/**
 * Plate identity that does not collide when two slices share a size and a header.
 * The digest covers the size, the first 1 MiB, the last 1 MiB, and the CTB
 * header layer count and print time when those bytes are present.
 */
export const SLICE_FINGERPRINT_CHUNK = 1024 * 1024;

export function ctbHeaderTags(head: Uint8Array): { layerCount: number; printTimeSeconds: number } {
  if (head.byteLength < 0x50) return { layerCount: 0, printTimeSeconds: 0 };
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const magic = view.getUint32(0, true);
  if ((magic & 0xffff) !== 0x12fd) return { layerCount: 0, printTimeSeconds: 0 };
  return {
    layerCount: view.getUint32(0x44, true),
    printTimeSeconds: view.getUint32(0x4c, true),
  };
}

/** Bytes that both the browser and the server hash. */
export function fingerprintPayload(size: number, head: Uint8Array, tail: Uint8Array): Uint8Array {
  const headTake = Math.min(head.length, SLICE_FINGERPRINT_CHUNK, size);
  const headBytes = head.subarray(0, headTake);
  const tailTake = Math.min(tail.length, SLICE_FINGERPRINT_CHUNK, size);
  const tailBytes = tail.subarray(tail.length - tailTake);
  const tags = ctbHeaderTags(headBytes);
  const out = new Uint8Array(16 + headBytes.length + tailBytes.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(Math.max(0, Math.floor(size))), true);
  view.setUint32(8, tags.layerCount, true);
  view.setUint32(12, tags.printTimeSeconds, true);
  out.set(headBytes, 16);
  out.set(tailBytes, 16 + headBytes.length);
  return out;
}
