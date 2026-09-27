import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createBufferCtbReader, encryptCtbSettingsBlock } from "../server/lib/ctb";
import { decodeRgb565Rle, extractCtbPreview } from "../server/lib/ctb-preview";

function redRun(pixels: number): Buffer {
  const encoded = Buffer.alloc(4);
  encoded[0] = 0x20;
  encoded[1] = 0xf8;
  encoded[2] = (pixels - 1) & 0xff;
  encoded[3] = 0x30 | (((pixels - 1) >> 8) & 0x0f);
  return encoded;
}

function pngRgb(png: Buffer, width: number, height: number): Buffer {
  let offset = 8;
  const parts: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") parts.push(data);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const rgb = Buffer.alloc(width * height * 3);
  const stride = width * 3;
  for (let y = 0; y < height; y += 1) {
    raw.copy(rgb, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return rgb;
}

test("CTB preview thumbnails decode RGB565 runs from classic and encrypted headers", () => {
  const decoded = decodeRgb565Rle(redRun(4), 2, 2);
  assert.ok(decoded);
  const classicRgb = pngRgb(decoded, 2, 2);
  assert.equal(classicRgb[0], 248);
  assert.equal(classicRgb[1], 0);
  assert.equal(classicRgb[2], 0);

  const classic = Buffer.alloc(0x180);
  classic.writeUInt32LE(0x12fd0086, 0);
  classic.writeUInt32LE(0x100, 0x3c);
  classic.writeUInt32LE(2, 0x100);
  classic.writeUInt32LE(2, 0x104);
  classic.writeUInt32LE(0x120, 0x108);
  classic.writeUInt32LE(4, 0x10c);
  redRun(4).copy(classic, 0x120);
  const fromClassic = extractCtbPreview(createBufferCtbReader(classic));
  assert.equal(fromClassic?.width, 2);
  assert.equal(fromClassic?.height, 2);
  assert.equal(pngRgb(fromClassic!.png, 2, 2)[0], 248);

  const settings = Buffer.alloc(180);
  settings.writeUInt32LE(0x180, 68);
  const encrypted = encryptCtbSettingsBlock(settings);
  const file = Buffer.alloc(0x180 + 16 + 4);
  file.writeUInt32LE(0x12fd0107, 0);
  file.writeUInt32LE(encrypted.length, 4);
  file.writeUInt32LE(0x30, 8);
  file.writeUInt32LE(5, 0x10);
  encrypted.copy(file, 0x30);
  file.writeUInt32LE(2, 0x180);
  file.writeUInt32LE(2, 0x184);
  file.writeUInt32LE(0x190, 0x188);
  file.writeUInt32LE(4, 0x18c);
  redRun(4).copy(file, 0x190);
  const fromEncrypted = extractCtbPreview(createBufferCtbReader(file));
  assert.equal(fromEncrypted?.width, 2);
  assert.equal(pngRgb(fromEncrypted!.png, 2, 2)[0], 248);
});
