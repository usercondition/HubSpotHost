/**
 * ChiTuBox CTB greymap RLE (UVtools DecodeCtbImage).
 * Runs are painted into a downscaled RGBA buffer so an 8K plate is not allocated whole.
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

  let pixel = 0;
  for (let n = 0; n < rle.length && pixel < pixels; n += 1) {
    let code = rle[n] ?? 0;
    let stride = 1;
    if ((code & 0x80) === 0x80) {
      code &= 0x7f;
      n += 1;
      if (n >= rle.length) break;
      const slen = rle[n] ?? 0;
      if ((slen & 0x80) === 0) {
        stride = slen;
      } else if ((slen & 0xc0) === 0x80) {
        if (n + 1 >= rle.length) break;
        stride = ((slen & 0x3f) << 8) + (rle[n + 1] ?? 0);
        n += 1;
      } else if ((slen & 0xe0) === 0xc0) {
        if (n + 2 >= rle.length) break;
        stride = ((slen & 0x1f) << 16) + ((rle[n + 1] ?? 0) << 8) + (rle[n + 2] ?? 0);
        n += 2;
      } else if ((slen & 0xf0) === 0xe0) {
        if (n + 3 >= rle.length) break;
        stride =
          ((slen & 0x0f) << 24) +
          ((rle[n + 1] ?? 0) << 16) +
          ((rle[n + 2] ?? 0) << 8) +
          (rle[n + 3] ?? 0);
        n += 3;
      } else {
        break;
      }
    }
    if (code !== 0) code = ((code << 1) | 1) & 0xff;
    if (stride < 1) continue;
    paint(pixel, stride, code);
    pixel += stride;
  }
  return { width: outW, height: outH, rgba };
}
