/**
 * Owner routes for Google Drive slice files.
 * The OAuth callback is the only route without the owner header; a one-time state is the gate.
 * None of these routes write to HubSpot.
 */
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Express, Request, Response } from "express";
import {
  isPlateFileName,
  libraryFolderName,
  libraryKitName,
  librarySliceName,
  plateDownloadSchema,
  plateKitRenameSchema,
  plateExtension,
  plateFileBulkSchema,
  plateFileLinkSchema,
  plateStlAttachSchema,
  plateOrderKeySchema,
  platePrepareSchema,
  plateUploadQuerySchema,
  type PlateFileRecord,
  type PlatePreviewStats,
} from "../../shared/plate-files";
import { SLICE_FINGERPRINT_CHUNK } from "../../shared/slice-fingerprint";
import {
  CtbParseError,
  createPrefixCtbReader,
  ctbLayerEntries,
  ctbLayerPlan,
  parseCtbFileFromPrefix,
  readCtbLayerBytes,
  sliceFingerprint,
  type CtbEncryptedSpan,
  type CtbLayerEntry,
  type CtbLayerPlan,
} from "./ctb";
import { extractCtbPreviewFromPrefix, extractUltxPreviewPng } from "./ctb-preview";
import {
  DriveReconnectError,
  DriveUnreadableError,
  beginGoogleOauth,
  disconnectDrive,
  driveConnectionStatus,
  ensureLibraryFolder,
  renameLibraryFolder,
  finishGoogleOauth,
  googleDriveConfigured,
  googleRedirectUri,
  openDriveMedia,
  uploadDriveFile,
} from "./google-drive";
import {
  countPlateFiles,
  findPlateBySha256,
  findReusablePlate,
  renameLibraryKit,
  getPlateFile,
  linkPlateFile,
  attachPlateStl,
  linkPlatePrint,
  listPlateFiles,
  readDownloadTicket,
  readPlatePreviewPng,
  recordUploadFailure,
  registerUploadedPlate,
  saveDownloadTicket,
  saveLibraryPending,
  savePlatePreview,
  storeBlankPlatePreview,
  unlinkPlateFile,
  upsertPlateFiles,
} from "./plate-files";
import { MESH_BYTE_BUDGET } from "./plate-mesh";
import { enqueueMissingPlateMeshes, enqueuePlateMesh } from "./plate-mesh-jobs";
import { getPrintFileRecord } from "./print-files";
import { firstIssue } from "./validation";

const NOT_IN_LIBRARY = "Not in Library yet.";
const UPLOAD_UNFINISHED = "The upload did not finish.";
const PREVIEW_PREFIX_BYTES = 8 * 1024 * 1024;
const MESH_MAX_BYTES = MESH_BYTE_BUDGET;

interface CachedLayerTable {
  plan: CtbLayerPlan;
  entries: CtbLayerEntry[];
  spans: Map<number, CtbEncryptedSpan>;
}

const layerTables = new Map<string, CachedLayerTable>();

function layerTableKey(file: PlateFileRecord): string {
  return `${file.driveFileId}:${file.sizeBytes ?? 0}:${file.modifiedAt ?? ""}`;
}

async function cachedLayerTable(
  file: PlateFileRecord,
  readRange: (fileId: string, start: number, length: number) => Promise<Buffer | null>,
): Promise<CachedLayerTable> {
  const key = layerTableKey(file);
  const hit = layerTables.get(key);
  if (hit) return hit;
  const size = file.sizeBytes ?? 0;
  const prefixLen = Math.min(PREVIEW_PREFIX_BYTES, size);
  const prefix = await readRange(file.driveFileId, 0, prefixLen);
  if (!prefix || prefix.length < 0x50) throw new CtbParseError("That plate has no layer preview.");
  const reader = createPrefixCtbReader(prefix, size);
  const plan = ctbLayerPlan(reader);
  let table = reader.read(plan.tableOffset, plan.tableBytes);
  if (!table) {
    const fetched = await readRange(file.driveFileId, plan.tableOffset, plan.tableBytes);
    if (!fetched || fetched.length < plan.tableBytes) throw new CtbParseError("That plate has no layer preview.");
    table = fetched;
  }
  const cache: CachedLayerTable = {
    plan,
    entries: ctbLayerEntries(plan, table, size),
    spans: new Map(),
  };
  layerTables.set(key, cache);
  if (layerTables.size > 24) {
    const oldest = layerTables.keys().next().value;
    if (oldest) layerTables.delete(oldest);
  }
  return cache;
}

function layerFailure(res: Response, error: unknown): void {
  if (error instanceof DriveReconnectError) {
    res.status(409).json({ ok: false, error: "Reconnect Google Drive.", reconnect: true });
    return;
  }
  if (error instanceof DriveUnreadableError) {
    res.status(404).json({ ok: false, error: "That plate has no layer preview." });
    return;
  }
  console.error("[ctb] layer preview", error instanceof Error ? error.message : error);
  res.status(422).json({ ok: false, error: "That plate has no layer preview." });
}

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function rejectOwner(req: Request, res: Response): boolean {
  const expected = process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH?.trim() || "";
  if (!expected) {
    res.status(503).json({ ok: false, error: "Paid Order Intake access code is not configured" });
    return true;
  }
  const provided = (req.get("x-paid-order-access-code") || "").trim().replace(/^Bearer\s+/i, "");
  if (!provided) {
    res.status(401).json({ ok: false, error: "No intake access code reached the live service" });
    return true;
  }
  const actual = crypto.createHash("sha256").update(provided, "utf8").digest("hex");
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ ok: false, error: "The intake access code does not match the active code" });
    return true;
  }
  return false;
}

function releaseBody(req: Request): void {
  if (!req.readableEnded) req.resume();
}

function requestOrigin(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || "";
  if (configured) return configured;
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  const host = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

function queryValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function attachmentName(name: string): string {
  const cleaned = name.replace(/[\r\n"]/g, "").replace(/[\\/]/g, " ").trim().slice(0, 180) || "slice-file";
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`;
}

/** Stop reading once `maxBytes` is in hand, so an ignored Range cannot pull the plate body. */
export async function takeResponseBytes(response: globalThis.Response, maxBytes: number): Promise<Buffer> {
  if (!response.body || maxBytes < 1) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const chunk = Buffer.from(value);
      const room = maxBytes - total;
      chunks.push(chunk.byteLength > room ? chunk.subarray(0, room) : chunk);
      total += Math.min(chunk.byteLength, room);
      if (chunk.byteLength > room) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

async function readDriveBounded(fileId: string, start: number, length: number): Promise<Buffer | null> {
  if (length < 1) return Buffer.alloc(0);
  const upstream = await openDriveMedia(fileId, `bytes=${start}-${start + length - 1}`);
  if (!upstream.ok && upstream.status !== 206) return null;
  const bytes = await takeResponseBytes(upstream, length);
  return bytes.length > 0 ? bytes : null;
}

function plateHeaderBlank(file: PlateFileRecord): boolean {
  if (!/\.ctb$/i.test(file.name)) return false;
  const stats = file.stats;
  return !stats || stats.layerCount == null || stats.printTimeSeconds == null || stats.resinVolumeMl == null;
}

function statsFromCtbPrefix(name: string, prefix: Buffer, fullSize: number): { png: Buffer | null; stats: PlatePreviewStats } | null {
  try {
    const metrics = parseCtbFileFromPrefix(name, prefix, fullSize);
    return {
      png: extractCtbPreviewFromPrefix(prefix, fullSize)?.png ?? null,
      stats: {
        printerProfile: metrics.printerProfile ?? "",
        layerCount: metrics.layerCount,
        layerHeightMm: metrics.layerHeightMm,
        printTimeSeconds: metrics.printTimeSeconds,
        resinVolumeMl: metrics.resinVolumeMl,
        resinCost: null,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Fill blank layers, time, resin, and a missing thumbnail from the CTB header.
 * One ranged read of the first bytes (the same 8 MB preview prefix uploads already use).
 * A row with no fingerprint also reads the last 1 MB so the existing digest can be stored.
 * The plate body is never downloaded. HubSpot and resin cost are not touched.
 */
export async function backfillBlankLibraryPlates(
  readRange: (fileId: string, start: number, length: number) => Promise<Buffer | null> = readDriveBounded,
): Promise<{ filled: number; skipped: number }> {
  let filled = 0;
  let skipped = 0;
  for (const file of listPlateFiles({}).files) {
    if (!plateHeaderBlank(file)) continue;
    const size = file.sizeBytes;
    if (size == null || size < 0x50) {
      skipped += 1;
      continue;
    }
    const prefixLen = Math.min(PREVIEW_PREFIX_BYTES, size);
    let prefix: Buffer | null = null;
    try {
      prefix = await readRange(file.driveFileId, 0, prefixLen);
    } catch (error) {
      if (error instanceof DriveReconnectError) throw error;
      skipped += 1;
      continue;
    }
    if (!prefix || prefix.length < 0x50) {
      skipped += 1;
      continue;
    }
    const parsed = statsFromCtbPrefix(file.name, prefix, size);
    const useful =
      parsed !== null &&
      (parsed.stats.layerCount != null ||
        parsed.stats.printTimeSeconds != null ||
        parsed.stats.resinVolumeMl != null ||
        (parsed.png !== null && parsed.png.length > 32));
    if (!parsed || !useful) {
      skipped += 1;
      continue;
    }
    let sha = file.sha256.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha)) {
      const tailLen = Math.min(SLICE_FINGERPRINT_CHUNK, size);
      let tail: Buffer | null = null;
      if (prefix.length >= size) tail = prefix.subarray(Math.max(0, size - tailLen), size);
      else {
        try {
          tail = await readRange(file.driveFileId, size - tailLen, tailLen);
        } catch (error) {
          if (error instanceof DriveReconnectError) throw error;
          tail = null;
        }
      }
      if (!tail || tail.length < 1) {
        skipped += 1;
        continue;
      }
      sha = sliceFingerprint(size, prefix.subarray(0, Math.min(prefix.length, SLICE_FINGERPRINT_CHUNK)), tail);
    }
    if (storeBlankPlatePreview(file.driveFileId, sha, parsed.png, parsed.stats)) filled += 1;
    else skipped += 1;
  }
  return { filled, skipped };
}

function cacheUploadedPreview(name: string, sha256: string, prefix: Buffer, fullSize: number, printer: string): void {
  if (!/^[a-f0-9]{64}$/.test(sha256) || prefix.length < 1) return;
  let png: Buffer | null = null;
  let stats: PlatePreviewStats = {
    printerProfile: printer,
    layerCount: null,
    layerHeightMm: null,
    printTimeSeconds: null,
    resinVolumeMl: null,
    resinCost: null,
  };
  try {
    if (/\.ctb$/i.test(name)) {
      png = extractCtbPreviewFromPrefix(prefix, fullSize)?.png ?? null;
      const metrics = parseCtbFileFromPrefix(name, prefix, fullSize);
      stats = {
        printerProfile: metrics.printerProfile ?? printer,
        layerCount: metrics.layerCount,
        layerHeightMm: metrics.layerHeightMm,
        printTimeSeconds: metrics.printTimeSeconds,
        resinVolumeMl: metrics.resinVolumeMl,
        resinCost: metrics.resinCost,
      };
    } else if (/\.ultx$/i.test(name)) {
      png = extractUltxPreviewPng(prefix);
    }
  } catch {
    /* Keep the plate even when the thumbnail cannot be read. */
  }
  savePlatePreview(sha256, png, stats);
}

function printRecordIdOf(raw: string): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function oauthFailure(res: Response): void {
  res
    .status(400)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><title>Google Drive</title><p>Google Drive did not connect. Go back to Setup and try Connect Google Drive again.</p><p><a href="/#/setup">Back to Setup</a></p>`,
    );
}

export function registerPlateLibraryRoutes(app: Express): void {
  app.get("/api/google/oauth/start", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    if (!googleDriveConfigured()) {
      return res.status(503).json({ ok: false, error: "Google Drive is not configured" });
    }
    const url = beginGoogleOauth(requestOrigin(req));
    return res.json({ ok: true, url, redirectUri: googleRedirectUri(requestOrigin(req)) });
  });

  app.get("/api/google/oauth/callback", async (req: Request, res: Response) => {
    const code = queryValue(req.query.code);
    const state = queryValue(req.query.state);
    if (!code || !state) return oauthFailure(res);
    try {
      await finishGoogleOauth({ code, state, origin: requestOrigin(req) });
      return res.redirect(302, "/#/setup");
    } catch {
      return oauthFailure(res);
    }
  });

  app.get("/api/google/drive", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    return res.json({ ok: true, ...driveConnectionStatus() });
  });

  app.post("/api/google/drive/disconnect", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    disconnectDrive();
    return res.json({ ok: true, ...driveConnectionStatus() });
  });

  app.get("/api/plate-files/reuse", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const file = findReusablePlate(queryValue(req.query.kit), queryValue(req.query.part), queryValue(req.query.printer));
    return res.json({ ok: true, file });
  });

  app.post("/api/plate-files/kit", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = plateKitRenameSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const to = parsed.data.to.replace(/\s+/g, " ").trim();
    const changed = renameLibraryKit(parsed.data.from, to);
    if (changed < 1) return res.status(404).json({ ok: false, error: "That kit is not in the Library." });
    try {
      await renameLibraryFolder(libraryFolderName(parsed.data.from), libraryFolderName(to));
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error || "");
      console.error("[drive] kit rename failed", raw);
    }
    return res.json({ ok: true, from: parsed.data.from, to, changed });
  });

  app.get("/api/plate-files", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    if (queryValue(req.query.summary) === "1") {
      return res.json({ ok: true, total: countPlateFiles(), files: [], failures: [] });
    }
    const orderKey = queryValue(req.query.orderKey);
    if (orderKey && !plateOrderKeySchema.safeParse(orderKey).success) {
      return res.status(400).json({ ok: false, error: "Use a deal or off-book order key" });
    }
    const listed = listPlateFiles({
      q: queryValue(req.query.q),
      printer: queryValue(req.query.printer),
      orderKey,
    });
    return res.json({ ok: true, ...listed });
  });

  app.post("/api/plate-files", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = plateFileBulkSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const files = upsertPlateFiles(parsed.data.files, "indexed");
    return res.json({ ok: true, files });
  });

  app.post("/api/plate-files/backfill", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    try {
      const result = await backfillBlankLibraryPlates();
      const meshes = enqueueMissingPlateMeshes();
      return res.json({ ok: true, ...result, meshes });
    } catch (error) {
      if (error instanceof DriveReconnectError) return res.status(409).json({ ok: false, error: "Reconnect Google Drive.", reconnect: true });
      return res.status(502).json({ ok: false, error: "Drive could not read that file." });
    }
  });

  app.post("/api/plate-files/:driveFileId/stl", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = plateStlAttachSchema.safeParse({ ...(req.body ?? {}), driveFileId: queryValue(req.params.driveFileId) });
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const match = /(?:\/d\/|[?&]id=)([-\w]{10,})/.exec(parsed.data.driveLink);
    if (!match?.[1]) return res.status(400).json({ ok: false, error: "Paste a Google Drive STL link." });
    const file = attachPlateStl(parsed.data.driveFileId, match[1], `https://drive.google.com/file/d/${match[1]}/view`);
    if (!file) return res.status(404).json({ ok: false, error: "That plate is not in the library." });
    return res.json({ ok: true, file, queued: enqueuePlateMesh(file.driveFileId) });
  });

  /** Explicit owner action: existing plates are never regenerated just by opening Library. */
  app.post("/api/plate-files/meshes/regenerate", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const queued = enqueueMissingPlateMeshes();
    return res.json({ ok: true, queued });
  });

  app.post("/api/plate-files/link", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = plateFileLinkSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const file = linkPlateFile(parsed.data.driveFileId, parsed.data.orderKey);
    if (!file) return res.status(404).json({ ok: false, error: "That slice file is not in the library." });
    return res.json({ ok: true, file });
  });

  app.post("/api/plate-files/unlink", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = plateFileLinkSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const file = unlinkPlateFile(parsed.data.driveFileId, parsed.data.orderKey);
    if (!file) return res.status(404).json({ ok: false, error: "That slice file is not in the library." });
    return res.json({ ok: true, file });
  });

  app.post("/api/plate-files/prepare", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = platePrepareSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const meta = parsed.data;
    const sliceName = librarySliceName(meta.fileName, meta.customer);
    if (meta.printRecordId) {
      const record = getPrintFileRecord(meta.printRecordId);
      const dealKey = record ? `deal:${record.hubspotDealId}` : "";
      if (!record || record.sha256 !== meta.sha256 || dealKey !== meta.orderKey) {
        return res.status(409).json({ ok: false, error: "That file does not match this plate." });
      }
    }
    const existing = findPlateBySha256(meta.orderKey, meta.sha256);
    if (existing) {
      if (meta.printRecordId) linkPlatePrint(existing.driveFileId, meta.printRecordId);
      return res.json({ ok: true, action: "linked", file: getPlateFile(existing.driveFileId) });
    }
    const drive = driveConnectionStatus();
    if (!drive.configured || !drive.connected) {
      if (meta.printRecordId) {
        saveLibraryPending({
          printRecordId: meta.printRecordId,
          orderKey: meta.orderKey,
          sha256: meta.sha256,
          name: sliceName,
          error: NOT_IN_LIBRARY,
        });
      }
      return res.json({ ok: true, action: "pending", reason: "not_connected" });
    }
    if (meta.printRecordId) {
      saveLibraryPending({
        printRecordId: meta.printRecordId,
        orderKey: meta.orderKey,
        sha256: meta.sha256,
        name: sliceName,
        error: UPLOAD_UNFINISHED,
      });
    }
    return res.json({ ok: true, action: "upload" });
  });

  app.get("/api/plate-previews/:sha256", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const sha = String(req.params.sha256 || "").trim().toLowerCase();
    const etag = `"${sha}"`;
    if (req.get("if-none-match") === etag) return res.status(304).end();
    const png = readPlatePreviewPng(sha);
    if (!png) return res.status(404).json({ ok: false, error: "No preview for that plate." });
    res.setHeader("etag", etag);
    res.setHeader("cache-control", "private, max-age=86400");
    res.status(200).type("png").send(png);
  });

  app.post("/api/plate-files/download", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = plateDownloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const file = getPlateFile(parsed.data.driveFileId);
    if (!file) return res.status(404).json({ ok: false, error: "That slice file is not in the library." });
    if (file.source !== "upload") {
      return res.json({ ok: true, fallback: true, webViewLink: file.webViewLink, fileName: file.name });
    }
    const ticket = saveDownloadTicket(file.driveFileId);
    return res.json({
      ok: true,
      fallback: false,
      url: `/api/plate-files/content?ticket=${encodeURIComponent(ticket.token)}`,
      fileName: file.name,
    });
  });

  app.get("/api/plate-files/content", async (req: Request, res: Response) => {
    const driveFileId = readDownloadTicket(queryValue(req.query.ticket));
    if (!driveFileId) return res.status(401).json({ ok: false, error: "That download link expired. Try Download again." });
    const file = getPlateFile(driveFileId);
    if (!file || file.source !== "upload") {
      return res.status(404).json({ ok: false, error: "That slice file is not in the library." });
    }
    try {
      const range = req.get("range");
      const upstream = await openDriveMedia(file.driveFileId, range);
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(502).json({ ok: false, error: "Drive could not read that file.", webViewLink: file.webViewLink });
      }
      res.status(upstream.status);
      res.setHeader("content-disposition", attachmentName(file.name));
      res.setHeader("accept-ranges", "bytes");
      res.setHeader("cache-control", "private, no-store");
      for (const name of ["content-type", "content-length", "content-range"]) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      if (!upstream.body) return res.end();
      await pipeline(Readable.fromWeb(upstream.body as import("stream/web").ReadableStream<Uint8Array>), res);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof DriveReconnectError) return res.status(409).json({ ok: false, error: "Reconnect Google Drive.", reconnect: true });
      if (error instanceof DriveUnreadableError) {
        return res.status(404).json({ ok: false, error: "Drive could not read that file.", webViewLink: file.webViewLink });
      }
      return res.status(502).json({ ok: false, error: "Drive could not read that file.", webViewLink: file.webViewLink });
    }
  });

  app.get("/api/plate-files/:driveFileId/layers", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const file = getPlateFile(queryValue(req.params.driveFileId));
    if (!file || !/\.ctb$/i.test(file.name) || file.sizeBytes == null) {
      return res.status(404).json({ ok: false, error: "That plate has no layer preview." });
    }
    try {
      const table = await cachedLayerTable(file, readDriveBounded);
      return res.json({
        ok: true,
        layerCount: table.plan.layerCount,
        width: table.plan.width,
        height: table.plan.height,
      });
    } catch (error) {
      return layerFailure(res, error);
    }
  });

  app.get("/api/plate-files/:driveFileId/layers/:index", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const file = getPlateFile(queryValue(req.params.driveFileId));
    const index = Number(queryValue(req.params.index));
    if (!file || !/\.ctb$/i.test(file.name) || file.sizeBytes == null || !Number.isInteger(index) || index < 0) {
      return res.status(404).json({ ok: false, error: "That plate has no layer preview." });
    }
    try {
      const table = await cachedLayerTable(file, readDriveBounded);
      const bytes = await readCtbLayerBytes(
        (start, length) => readDriveBounded(file.driveFileId, start, length),
        table.plan,
        table.entries,
        table.spans,
        index,
      );
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("cache-control", "private, no-store");
      res.setHeader("x-layer-width", String(table.plan.width));
      res.setHeader("x-layer-height", String(table.plan.height));
      res.setHeader("x-layer-count", String(table.plan.layerCount));
      res.setHeader("x-layer-index", String(index));
      return res.send(bytes);
    } catch (error) {
      return layerFailure(res, error);
    }
  });

  app.get("/api/plate-files/:driveFileId/mesh", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const file = getPlateFile(queryValue(req.params.driveFileId));
    if (!file?.meshDriveFileId) return res.status(404).json({ ok: false, error: "That plate has no 3D view yet." });
    try {
      const upstream = await openDriveMedia(file.meshDriveFileId, undefined);
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(502).json({ ok: false, error: "Drive could not read that file." });
      }
      const bytes = await takeResponseBytes(upstream, MESH_MAX_BYTES);
      if (bytes.length < 1) return res.status(404).json({ ok: false, error: "That plate has no 3D view yet." });
      res.setHeader("content-type", "model/gltf-binary");
      res.setHeader("cache-control", "private, no-store");
      return res.send(bytes);
    } catch (error) {
      if (error instanceof DriveReconnectError) return res.status(409).json({ ok: false, error: "Reconnect Google Drive.", reconnect: true });
      return res.status(502).json({ ok: false, error: "Drive could not read that file." });
    }
  });

  app.post("/api/plate-files/upload", async (req: Request, res: Response) => {
    if (rejectOwner(req, res)) {
      releaseBody(req);
      return;
    }
    const parsed = plateUploadQuerySchema.safeParse({
      orderKey: queryValue(req.query.orderKey),
      fileName: queryValue(req.query.fileName),
      printer: queryValue(req.query.printer),
      notes: queryValue(req.query.notes),
      kit: queryValue(req.query.kit),
      customer: queryValue(req.query.customer),
      sha256: queryValue(req.query.sha256),
      printRecordId: queryValue(req.query.printRecordId),
    });
    if (!parsed.success || !isPlateFileName(parsed.success ? parsed.data.fileName : "")) {
      releaseBody(req);
      return res.status(400).json({ ok: false, error: parsed.success ? "That file type is not a slice or mesh." : firstIssue(parsed.error) });
    }
    const size = Number(req.get("content-length"));
    if (!Number.isFinite(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
      releaseBody(req);
      return res.status(400).json({ ok: false, error: "Send the file with a Content-Length up to 2 GB." });
    }
    const meta = parsed.data;
    const sliceName = librarySliceName(meta.fileName, meta.customer);
    const catalogKit = libraryKitName(meta.kit || meta.fileName, meta.customer);
    const printRecordId = printRecordIdOf(meta.printRecordId);
    const clientSha = /^[a-f0-9]{64}$/.test(meta.sha256.toLowerCase()) ? meta.sha256.toLowerCase() : "";
    if (clientSha) {
      const existing = findPlateBySha256(meta.orderKey, clientSha);
      if (existing) {
        if (printRecordId) linkPlatePrint(existing.driveFileId, printRecordId);
        releaseBody(req);
        return res.status(200).json({ ok: true, linked: true, file: getPlateFile(existing.driveFileId) });
      }
    }
    const fail = (status: number, error: string, extra?: Record<string, unknown>) => {
      if (printRecordId) {
        saveLibraryPending({
          printRecordId,
          orderKey: meta.orderKey,
          sha256: clientSha,
          name: sliceName,
          error: status === 503 ? NOT_IN_LIBRARY : error,
        });
      } else {
        recordUploadFailure({ orderKey: meta.orderKey, name: sliceName, printer: meta.printer, notes: meta.notes, error });
      }
      releaseBody(req);
      return res.status(status).json({ ok: false, error, ...extra });
    };
    if (!googleDriveConfigured()) return fail(503, "Google Drive is not configured");
    try {
      const folder = await ensureLibraryFolder(libraryFolderName(catalogKit));
      const kept: Buffer[] = [];
      let keptBytes = 0;
      let uploadTail = Buffer.alloc(0);
      const uploaded = await uploadDriveFile({
        access: folder.access,
        folderId: folder.folderId,
        name: sliceName,
        size,
        body: req,
        onPrefix: (chunk, offset) => {
          const nextTail = Buffer.concat([uploadTail, chunk]);
          uploadTail = nextTail.length > 1024 * 1024 ? nextTail.subarray(nextTail.length - 1024 * 1024) : nextTail;
          if (offset >= PREVIEW_PREFIX_BYTES || keptBytes >= PREVIEW_PREFIX_BYTES) return;
          const take = chunk.subarray(0, PREVIEW_PREFIX_BYTES - keptBytes);
          kept.push(Buffer.from(take));
          keptBytes += take.length;
        },
      });
      if (!uploaded.id) return fail(502, "Drive did not confirm the file.");
      const prefix = Buffer.concat(kept);
      const sha256 = prefix.length > 0 ? sliceFingerprint(size, prefix.subarray(0, Math.min(prefix.length, 1024 * 1024)), uploadTail) : clientSha;
      cacheUploadedPreview(meta.fileName, sha256, prefix, size, meta.printer);
      const record = printRecordId ? getPrintFileRecord(printRecordId) : null;
      const linkedRecord = record && record.sha256 === sha256 ? printRecordId : undefined;
      const file = registerUploadedPlate({
        driveFileId: uploaded.id,
        name: uploaded.name || sliceName,
        webViewLink: uploaded.webViewLink,
        sizeBytes: uploaded.sizeBytes,
        modifiedAt: uploaded.modifiedAt,
        mimeType: uploaded.mimeType,
        extension: plateExtension(meta.fileName),
        printer: meta.printer,
        kit: catalogKit,
        customer: meta.customer,
        kitTags: catalogKit,
        notes: meta.notes,
        sha256,
        orderKey: meta.orderKey,
        printRecordId: linkedRecord,
      });
      if (printRecordId && !linkedRecord) {
        saveLibraryPending({
          printRecordId,
          orderKey: meta.orderKey,
          sha256: clientSha || sha256,
          name: sliceName,
          error: "That file does not match this plate.",
        });
      }
      if (/\.ctb$/i.test(file.name)) enqueuePlateMesh(file.driveFileId);
      return res.status(201).json({ ok: true, file });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error || "");
      console.error("[drive] upload failed", raw);
      if (error instanceof DriveReconnectError) {
        return fail(409, "Reconnect Google Drive.", { reconnect: true });
      }
      return fail(502, "Drive upload failed.");
    }
  });
}
