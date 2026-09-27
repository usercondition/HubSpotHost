/**
 * Expanded Library plate: layer slider mid-plate, and the 3D view, at 1440 and 390.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";
import playwright from "playwright";

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
  modelDriveFileId: "model-torso",
  modelName: "torso.stl",
};

function bandRle(): Buffer {
  const bytes: number[] = [];
  for (let y = 0; y < 48; y += 1) {
    const white = y >= 16 && y < 32;
    bytes.push(0x80 | (white ? 0x7f : 0), 64);
  }
  return Buffer.from(bytes);
}

function tetrahedronStl(): Buffer {
  const vertices: Array<[number, number, number]> = [
    [0, 0, 0],
    [1, 0, 0],
    [0.2, 1, 0],
    [0.4, 0.3, 1],
  ];
  const faces = [
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 1],
    [1, 3, 2],
  ];
  const body = Buffer.alloc(80 + 4 + faces.length * 50);
  body.write("public domain tetrahedron", 0, "ascii");
  body.writeUInt32LE(faces.length, 80);
  faces.forEach((face, index) => {
    const at = 84 + index * 50;
    face.forEach((vertex, corner) => {
      const [x, y, z] = vertices[vertex]!;
      const point = at + 12 + corner * 12;
      body.writeFloatLE(x, point);
      body.writeFloatLE(y, point + 4);
      body.writeFloatLE(z, point + 8);
    });
  });
  return body;
}

const RLE = bandRle();
const STL = tetrahedronStl();

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
      if (/\/api\/plate-files\/[^/]+\/model$/.test(pathname)) {
        await route.fulfill({ status: 200, contentType: "application/octet-stream", body: STL });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.addInitScript(() => {
      sessionStorage.setItem("print-ops-owner-code", "preview");
    });

    const openLayers = async () => {
      layerHits.length = 0;
      await page.goto(`${base}/#/library`, { waitUntil: "domcontentloaded" });
      await page.locator("[data-testid='button-plate-menu-file-torso']").click();
      const addModel = page.locator("[data-testid='button-add-model-file-torso']");
      await addModel.waitFor();
      const menuText = await addModel.innerText();
      assert.equal(menuText, "Add 3D model");
      await page.locator("[data-testid='button-preview-plate-file-torso']").click();
      await page.locator("[data-testid='plate-layer-scan']").waitFor();
      await page.waitForFunction(() => {
        const canvas = document.querySelector("[data-testid='canvas-plate-layer']");
        return Boolean(canvas && (canvas as HTMLCanvasElement).width > 0);
      });
      await page.locator("[data-testid='input-layer-slider']").evaluate((el) => {
        const input = el as HTMLInputElement;
        for (let i = 0; i < 30; i += 1) {
          input.value = String((i * 13) % 420);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        input.value = "209";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForFunction(() => {
        const label = document.querySelector("[data-testid='text-layer-index']");
        return Boolean(label && (label.textContent || "").includes("210") && (label.textContent || "").includes("420"));
      });
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
    await page.waitForTimeout(500);
    await page.locator("[data-testid='panel-plate-preview']").screenshot({ path: `${ARTIFACTS}/library-model-desktop-1440.png` });

    await page.setViewportSize({ width: 390, height: 844 });
    await openLayers();
    await page.locator("[data-testid='panel-plate-preview']").screenshot({ path: `${ARTIFACTS}/library-layers-phone-390.png` });
    await page.locator("[data-testid='button-view-model']").click();
    await page.locator("[data-testid='plate-model-view'] canvas").waitFor();
    await page.waitForTimeout(500);
    await page.locator("[data-testid='panel-plate-preview']").screenshot({ path: `${ARTIFACTS}/library-model-phone-390.png` });
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
});
