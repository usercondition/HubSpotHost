import { walkCtbRle } from "@shared/ctb-rle";

/**
 * Paint a ChiTuBox layer into a downscaled RGBA buffer so an 8K plate is not allocated whole.
 */
export function decodeCtbRle(
  rle: Uint8Array,
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; rgba: Uint8ClampedArray } {
  if (width < 1 || height < 1 || width > 65_536 || height > 65_536) {
    throw new Error("Layer size is out of range");
  }
  const longest = Math.max(width, height);
  const edge = Math.max(1, Math.floor(maxEdge));
  const scale = Math.min(1, edge / longest);
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const rgba = new Uint8ClampedArray(outW * outH * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const pixels = width * height;

  const paint = (start: number, stride: number, gray: number) => {
    const end = Math.min(start + stride, pixels);
    let cursor = start;
    while (cursor < end) {
      const x = cursor % width;
      const y = (cursor / width) | 0;
      const ox = Math.min(outW - 1, ((x * outW) / width) | 0);
      const oy = Math.min(outH - 1, ((y * outH) / height) | 0);
      const at = (oy * outW + ox) * 4;
      rgba[at] = gray;
      rgba[at + 1] = gray;
      rgba[at + 2] = gray;
      const nextX = Math.min(width, Math.ceil(((ox + 1) * width) / outW));
      const jump = Math.max(1, nextX - x);
      const rowEnd = (y + 1) * width;
      cursor = cursor + jump >= rowEnd ? rowEnd : cursor + jump;
    }
  };

  walkCtbRle(rle, pixels, paint);
  return { width: outW, height: outH, rgba };
}
