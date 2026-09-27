/**
 * ChiTuBox greymap RLE (UVtools DecodeCtbImage).
 * One walker for the layer scanner and the plate mesh.
 */
export function walkCtbRle(
  rle: Uint8Array,
  pixelCount: number,
  onRun: (start: number, stride: number, gray: number) => void,
): void {
  if (pixelCount < 1) return;
  let pixel = 0;
  for (let n = 0; n < rle.length && pixel < pixelCount; n += 1) {
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
    onRun(pixel, stride, code);
    pixel += stride;
  }
}
