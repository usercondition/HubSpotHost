/**
 * Expanded Library plate: layer slider mid-plate, and a 3D mesh built from a test .ctb, at 1440 and 390.
 * The Knight Castellan Drive files are not readable from this VM, so the mesh is generated here
 * from a classic CTB pyramid that uses the same layer-table layout.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";
import playwright from "playwright";
import { buildPlateGlb } from "../server/lib/plate-mesh";

const { chromium } = playwright;
const ARTIFACTS = process.env.ARTIFACTS_DIR?.trim() || "/opt/cursor/artifacts";

const FILE = {
  driveFileId: "file-torso",
  name: "Knight_Castellan_Torso.ctb",
  webViewLink: "https://drive.google.com/file/d/file-torso/view",
  sizeBytes: 188743680,
  modifiedAt: "2026-09-26T20:00:00.000Z",
  mimeType: "application/octet-stream",
  extension: ".ctb",
  printer: "Mighty 8K",
  kit: "Knight Castellan",
  customer: "",
  kitTags: "Knight Castellan",
  notes: "",
  source: "upload",
  sha256: "ab".repeat(32),
  orderKeys: ["deal:1"],
  printRecordIds: [],
  hasPreview: false,
  stats: {
    printerProfile: "Mighty 8K",
    layerCount: 420,
    layerHeightMm: 0.05,
    printTimeSeconds: 14400,
    resinVolumeMl: 31.25,
    resinCost: 18.4,
  },
  meshDriveFileId: "mesh-torso",
  meshState: "ready",
};

function rle(white: boolean, length: number): number[] {
  if (length < 1) return [];
  const head = 0x80 | (white ? 0x7f : 0);
  if (length < 0x80) return [head, length];
  if (length < 0x4000) return [head, 0x80 | (length >> 8), length & 0xff];
  return [head, 0xc0 | ((length >> 16) & 0x1f), (length >> 8) & 0xff, length & 0xff];
}

/** Several separated parts and a thin support, at 0.05 mm so the viewer frames the mesh. */
function testPartsCtb(): Buffer {
  const pixel = 0.05;
  const width = 480;
  const height = 320;
  const layerCount = 140;
  const tableOffset = 0x80;
  const mm = (value: number) => Math.round(value / pixel);
  const boxes = [
    { x0: mm(2), x1: mm(10), y0: mm(2), y1: mm(8), z0: mm(1.6), z1: mm(6.5) },
    { x0: mm(14), x1: mm(19), y0: mm(2.4), y1: mm(6.4), z0: mm(2), z1: mm(6) },
    { x0: mm(4), x1: mm(12), y0: mm(11), y1: mm(12.4), z0: mm(1.2), z1: mm(5.5) },
    { x0: mm(4), x1: mm(4.8), y0: mm(4), y1: mm(4.8), z0: 0, z1: mm(2.2) },
    { x0: mm(7), x1: mm(7.8), y0: mm(5), y1: mm(5.8), z0: 0, z1: mm(2.2) },
    { x0: mm(21), x1: mm(21.8), y0: mm(8), y1: mm(8.8), z0: 0, z1: mm(3) },
  ];
  const layers: Buffer[] = [];
  for (let layer = 0; layer < layerCount; layer += 1) {
    const bytes: number[] = [];
    for (let y = 0; y < height; y += 1) {
      const spans: Array<[number, number]> = [];
      for (const box of boxes) {
        if (layer < box.z0 || layer >= box.z1 || y < box.y0 || y >= box.y1) continue;
        spans.push([box.x0, box.x1]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      let cursor = 0;
      for (const [x0, x1] of spans) {
        if (x0 > cursor) bytes.push(...rle(false, x0 - cursor));
        bytes.push(...rle(true, x1 - x0));
        cursor = x1;
      }
      if (cursor < width) bytes.push(...rle(false, width - cursor));
    }
    layers.push(Buffer.from(bytes));
  }
  const dataStart = tableOffset + layerCount * 36;
  const file = Buffer.alloc(dataStart + layers.reduce((sum, layer) => sum + layer.length, 0));
  file.writeUInt32LE(0x12fd0086, 0);
  file.writeFloatLE(width * pixel, 0x08);
  file.writeFloatLE(height * pixel, 0x0c);
  file.writeFloatLE(layerCount * pixel, 0x10);
  file.writeFloatLE(pixel, 0x20);
  file.writeUInt32LE(width, 0x34);
  file.writeUInt32LE(height, 0x38);
  file.writeUInt32LE(tableOffset, 0x40);
  file.writeUInt32LE(layerCount, 0x44);
  let cursor = dataStart;
  layers.forEach((layer, index) => {
    const at = tableOffset + index * 36;
    file.writeUInt32LE(cursor, at + 12);
    file.writeUInt32LE(layer.length, at + 16);
    layer.copy(file, cursor);
    cursor += layer.length;
  });
  return file;
}

function bandRle(): Buffer {
  const bytes: number[] = [];
  for (let y = 0; y < 48; y += 1) {
    const white = y >= 16 && y < 32;
    bytes.push(0x80 | (white ? 0x7f : 0), 64);
  }
  return Buffer.from(bytes);
}

const RLE = bandRle();

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

test("Library layer scan and 3D view at 1440 and 390", { timeout: 180_000 }, async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  const parts = testPartsCtb();
  const meshStarted = Date.now();
  const MESH = await buildPlateGlb(
    async (start, length) => parts.subarray(start, Math.min(parts.length, start + length)),
    parts.length,
  );
  const meshMs = Date.now() - meshStarted;
  assert.ok(MESH.length > 100 && MESH.length <= 8 * 1024 * 1024, `test mesh ${MESH.length} bytes in ${meshMs}ms`);
  console.log(`[plate-mesh] test ctb parts ${MESH.length} bytes in ${meshMs}ms`);
  const port = await freePort();
  const child: ChildProcess = spawn("node", ["dist/index.cjs"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), DRY_RUN: "true" },
    stdio: "ignore",
  });
  let browser: playwright.Browser | null = null;
  const layerHits: number[] = [];
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`${base}/`);
        if (response.ok) break;
      } catch {
        // server still booting
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    } catch {
      browser = await chromium.launch({ headless: true });
    }
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname === "/api/plate-files") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, files: [FILE], failures: [], pending: [] }),
        });
        return;
      }
      const layer = /\/api\/plate-files\/[^/]+\/layers\/(\d+)$/.exec(pathname);
      if (layer) {
        layerHits.push(Number(layer[1]));
        await route.fulfill({ status: 200, contentType: "application/octet-stream", body: RLE });
        return;
      }
      if (/\/api\/plate-files\/[^/]+\/layers$/.test(pathname)) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, layerCount: 420, width: 64, height: 48 }),
        });
        return;
      }
      if (/\/api\/plate-files\/[^/]+\/mesh$/.test(pathname)) {
        await route.fulfill({ status: 200, contentType: "model/gltf-binary", body: MESH });
        return;
      }
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false }) });
    });
    await page.addInitScript(() => {
      sessionStorage.setItem("print-ops-owner-code", "preview");
    });

    const openLayers = async () => {
      layerHits.length = 0;
      const close = page.locator("[data-testid='button-close-plate-preview']");
      if (await close.count()) await close.click();
      await page.goto(`${base}/#/library`, { waitUntil: "domcontentloaded" });
      await page.locator("[data-testid='library-row-file-torso']").waitFor();
      await page.locator("[data-testid='button-plate-menu-file-torso']").click();
      assert.equal(await page.locator("[data-testid='button-add-model-file-torso']").count(), 0);
      await page.locator("[data-testid='button-preview-plate-file-torso']").click();
      await page.locator("[data-testid='plate-layer-scan']").waitFor();
      await page.waitForFunction(() => {
        const canvas = document.querySelector("[data-testid='canvas-plate-layer']");
        return Boolean(canvas && (canvas as HTMLCanvasElement).width > 0);
      });
      const slider = page.locator("[data-testid='input-layer-slider']");
      for (let i = 0; i < 12; i += 1) await slider.fill(String(i * 17));
      await slider.fill("209");
      await page.waitForTimeout(500);
      const label = await page.locator("[data-testid='text-layer-index']").innerText();
      const sliderValue = await slider.inputValue();
      if (!label.includes("210") || !label.includes("420")) {
        throw new Error(`layer label ${JSON.stringify(label)} slider ${sliderValue} hits ${layerHits.join(",")} errors ${pageErrors.join(" | ")}`);
      }
      await page.waitForTimeout(400);
      const previewText = await page.locator("[data-testid='panel-plate-preview']").innerText();
      assert.equal(/Ada|Daniel|Wayne|Glenn/.test(previewText), false, previewText);
      assert.match(previewText, /Knight Castellan/);
      assert.ok(layerHits.includes(209), `missing mid layer (${layerHits.join(",")})`);
      assert.ok(layerHits.length < 8, `slider fired ${layerHits.length} layer reads`);
    };

    await page.setViewportSize({ width: 1440, height: 900 });
    await openLayers();
    await page.locator("[data-testid='panel-plate-preview']").screenshot({ path: `${ARTIFACTS}/library-layers-desktop-1440.png` });
    await page.locator("[data-testid='button-view-model']").click();
    await page.locator("[data-testid='plate-model-view'] canvas").waitFor();
    await page.locator("[data-testid='button-reset-mesh-view']").click();
    await page.waitForTimeout(500);
    await page.locator("[data-testid='panel-plate-preview']").screenshot({ path: `${ARTIFACTS}/library-model-desktop-1440.png` });

    await page.setViewportSize({ width: 390, height: 844 });
    await openLayers();
    await page.locator("[data-testid='panel-plate-preview']").screenshot({ path: `${ARTIFACTS}/library-layers-phone-390.png` });
    await page.locator("[data-testid='button-view-model']").click();
    await page.locator("[data-testid='plate-model-view'] canvas").waitFor();
    await page.locator("[data-testid='button-reset-mesh-view']").click();
    await page.waitForTimeout(500);
    await page.locator("[data-testid='panel-plate-preview']").screenshot({ path: `${ARTIFACTS}/library-model-phone-390.png` });
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
});
