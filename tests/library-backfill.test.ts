/**
 * Library backfill reads a CTB header prefix, fills blank layers/time/resin,
 * and never writes HubSpot or a resin cost.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptCtbSettingsBlock } from "../server/lib/ctb";
import { saveDriveConnection, setDriveFetchForTest } from "../server/lib/google-drive";
import { resetOrderLinkStore } from "../server/lib/order-links";
import { getPlateFile, savePlatePreview, upsertPlateFiles } from "../server/lib/plate-files";
import { whenPlateMeshesIdle } from "../server/lib/plate-mesh-jobs";
import { backfillBlankLibraryPlates, registerPlateLibraryRoutes, takeResponseBytes } from "../server/lib/plate-routes";

const FULL = 458_000_000;

function headerPrefix(): Buffer {
  const settingsPlain = Buffer.alloc(288, 0);
  settingsPlain.writeFloatLE(44, 104);
  settingsPlain.writeUInt32LE(18_000, 76);
  settingsPlain.writeUInt32LE(900, 64);
  settingsPlain.writeFloatLE(9.5, 112);
  const encrypted = encryptCtbSettingsBlock(settingsPlain);
  const prefix = Buffer.alloc(0x30 + encrypted.length, 0);
  prefix.writeUInt32LE(0x12fd0107, 0);
  prefix.writeUInt32LE(encrypted.length, 4);
  prefix.writeUInt32LE(0x30, 8);
  prefix.writeUInt32LE(4, 0x10);
  encrypted.copy(prefix, 0x30);
  return prefix;
}

function farPrefix(): Buffer {
  const prefix = Buffer.alloc(0x30, 0);
  prefix.writeUInt32LE(0x12fd0107, 0);
  prefix.writeUInt32LE(200, 4);
  prefix.writeUInt32LE(9_000_000, 8);
  return prefix;
}

test("takeResponseBytes stops at the requested prefix", async () => {
  const taken = await takeResponseBytes(new Response(Buffer.alloc(5000, 1)), 100);
  assert.equal(taken.length, 100);
  assert.equal(taken[0], 1);
});

test("library backfill fills blank header fields and does not touch HubSpot or cost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "library-backfill-"));
  const previous = {
    db: process.env.ORDER_LINKS_DB_FILE,
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
    hash: process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH,
    client: process.env.GOOGLE_OAUTH_CLIENT_ID,
    secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  };
  const calls: string[] = [];
  const mock = http.createServer((_req, res) => {
    calls.push("hubspot");
    res.statusCode = 500;
    res.end("nope");
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const mockPort = (mock.address() as { port: number }).port;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update("stack-test", "utf8").digest("hex");
  process.env.GOOGLE_OAUTH_CLIENT_ID = "drive-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "drive-secret";
  resetOrderLinkStore();

  const prefix = headerPrefix();
  const sha = "ab".repeat(32);
  const reads: Array<{ id: string; start: number; length: number }> = [];
  upsertPlateFiles(
    [
      {
        driveFileId: "cost-plate",
        name: "Knight_Castellan_Torso.ctb",
        webViewLink: "",
        sizeBytes: FULL,
        sha256: sha,
        printer: "Mighty 8K",
        kit: "Knight Castellan",
      },
      {
        driveFileId: "indexed-plate",
        name: "Knight_Castellan_Bits.ctb",
        webViewLink: "",
        sizeBytes: 2_000_000,
        sha256: "",
        printer: "Mighty 8K",
        kit: "Knight Castellan",
      },
      {
        driveFileId: "far-settings",
        name: "Knight_Castellan_Far.ctb",
        webViewLink: "",
        sizeBytes: FULL,
        sha256: "",
        kit: "Knight Castellan",
      },
      {
        driveFileId: "mesh-plate",
        name: "Knight_Castellan.stl",
        webViewLink: "",
        sizeBytes: FULL,
        kit: "Knight Castellan",
      },
    ],
    "indexed",
  );
  savePlatePreview(sha, null, {
    printerProfile: "Mighty 8K",
    layerCount: null,
    layerHeightMm: null,
    printTimeSeconds: null,
    resinVolumeMl: null,
    resinCost: 12.5,
  });

  const app = express();
  registerPlateLibraryRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const headers = { "x-paid-order-access-code": "stack-test" };

  try {
    const first = await backfillBlankLibraryPlates(async (id, start, length) => {
      reads.push({ id, start, length });
      assert.ok(length <= 8 * 1024 * 1024, `range is the whole plate (${length})`);
      if (id === "far-settings") return farPrefix();
      if (start > 0) return Buffer.alloc(Math.min(length, 64), 7);
      return prefix;
    });
    assert.equal(first.filled, 2);
    assert.equal(first.skipped, 1);
    assert.equal(reads.some((read) => read.id === "mesh-plate"), false);
    assert.equal(reads.some((read) => read.id === "cost-plate" && read.start > 0), false);
    assert.equal(reads.some((read) => read.id === "indexed-plate" && read.start > 0), true);
    assert.equal(reads.filter((read) => read.id === "far-settings").length, 1);

    const kept = getPlateFile("cost-plate");
    assert.equal(kept?.sha256, sha);
    assert.equal(kept?.stats?.layerCount, 900);
    assert.equal(kept?.stats?.printTimeSeconds, 18_000);
    assert.equal(kept?.stats?.resinVolumeMl, 44);
    assert.equal(kept?.stats?.resinCost, 12.5);

    const indexed = getPlateFile("indexed-plate");
    assert.match(indexed?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.notEqual(indexed?.sha256, "");
    assert.equal(indexed?.stats?.layerCount, 900);
    assert.equal(indexed?.stats?.resinCost, null);
    assert.equal(getPlateFile("far-settings")?.sha256, "");
    assert.equal(getPlateFile("far-settings")?.stats, null);

    const second = await backfillBlankLibraryPlates(async (id) => {
      if (id === "far-settings") return farPrefix();
      throw new Error(`filled plate was read again (${id})`);
    });
    assert.equal(second.filled, 0);
    assert.equal(second.skipped, 1);

    const locked = await fetch(`http://127.0.0.1:${port}/api/plate-files/backfill`, { method: "POST" });
    assert.equal(locked.status, 401);

    upsertPlateFiles(
      [
        {
          driveFileId: "route-plate",
          name: "Knight_Castellan_Route.ctb",
          webViewLink: "",
          sizeBytes: FULL,
          sha256: "cd".repeat(32),
          printer: "Mighty 8K",
          kit: "Knight Castellan",
        },
      ],
      "indexed",
    );
    const ranges: string[] = [];
    saveDriveConnection({ email: "miguel.plates@gmail.com", refreshToken: "refresh-marker" });
    setDriveFetchForTest(async (input, init) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "access-ok" }), { status: 200 });
      }
      if (url.includes("alt=media")) {
        const headerBag = (init?.headers ?? {}) as Record<string, string>;
        ranges.push(`${url} ${headerBag.range ?? ""}`);
        const body = url.includes("far-settings") ? farPrefix() : prefix;
        return new Response(body, { status: 206 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const filled = await fetch(`http://127.0.0.1:${port}/api/plate-files/backfill`, { method: "POST", headers });
    assert.equal(filled.status, 200);
    const body = (await filled.json()) as { ok: boolean; filled: number; meshes: number };
    assert.equal(body.ok, true);
    assert.equal(body.filled, 1);
    assert.ok(body.meshes >= 1);
    await whenPlateMeshesIdle();
    const prefixRange = `bytes=0-${8 * 1024 * 1024 - 1}`;
    assert.ok(ranges.some((range) => range.includes("route-plate") && range.includes(prefixRange)));
    assert.ok(
      ranges.every((range) => {
        const match = /bytes=(\d+)-(\d+)/.exec(range);
        if (!match) return false;
        return Number(match[2]) - Number(match[1]) + 1 <= 8 * 1024 * 1024;
      }),
    );
    const routed = getPlateFile("route-plate");
    assert.equal(routed?.stats?.layerCount, 900);
    assert.equal(routed?.stats?.resinCost, null);
    assert.equal(routed?.sha256, "cd".repeat(32));
    assert.equal(calls.length, 0);
  } finally {
    setDriveFetchForTest(null);
    server.close();
    mock.close();
    resetOrderLinkStore();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("ORDER_LINKS_DB_FILE", previous.db);
    restore("DRY_RUN", previous.dry);
    restore("ALLOW_HUBSPOT_WRITES", previous.writes);
    restore("HUBSPOT_API_BASE", previous.base);
    restore("HUBSPOT_ACCESS_TOKEN", previous.token);
    restore("PAID_ORDER_INTAKE_ACCESS_CODE_HASH", previous.hash);
    restore("GOOGLE_OAUTH_CLIENT_ID", previous.client);
    restore("GOOGLE_OAUTH_CLIENT_SECRET", previous.secret);
    rmSync(dir, { recursive: true, force: true });
  }
});
