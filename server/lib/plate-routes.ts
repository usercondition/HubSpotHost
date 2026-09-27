/**
 * Owner routes for Google Drive slice files.
 * The OAuth callback is the only route without the owner header; a one-time state is the gate.
 * None of these routes write to HubSpot.
 */
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import {
  isPlateFileName,
  orderFolderName,
  plateExtension,
  plateFileBulkSchema,
  plateFileLinkSchema,
  plateOrderKeySchema,
  plateUploadQuerySchema,
} from "../../shared/plate-files";
import {
  DriveReconnectError,
  beginGoogleOauth,
  disconnectDrive,
  driveConnectionStatus,
  ensureOrderFolder,
  finishGoogleOauth,
  googleDriveConfigured,
  googleRedirectUri,
  uploadDriveFile,
} from "./google-drive";
import { countPlateFiles, linkPlateFile, listPlateFiles, recordUploadFailure, registerUploadedPlate, unlinkPlateFile, upsertPlateFiles } from "./plate-files";
import { firstIssue } from "./validation";

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
    const fail = (status: number, error: string, extra?: Record<string, unknown>) => {
      recordUploadFailure({ orderKey: meta.orderKey, name: meta.fileName, printer: meta.printer, notes: meta.notes, error });
      releaseBody(req);
      return res.status(status).json({ ok: false, error, ...extra });
    };
    if (!googleDriveConfigured()) return fail(503, "Google Drive is not configured");
    try {
      const folder = await ensureOrderFolder(orderFolderName(meta.kit, meta.customer, meta.orderKey));
      const uploaded = await uploadDriveFile({
        access: folder.access,
        folderId: folder.folderId,
        name: meta.fileName,
        size,
        body: req,
      });
      if (!uploaded.id) return fail(502, "Drive did not confirm the file.");
      const file = registerUploadedPlate({
        driveFileId: uploaded.id,
        name: uploaded.name || meta.fileName,
        webViewLink: uploaded.webViewLink,
        sizeBytes: uploaded.sizeBytes,
        modifiedAt: uploaded.modifiedAt,
        mimeType: uploaded.mimeType,
        extension: plateExtension(meta.fileName),
        printer: meta.printer,
        kit: meta.kit,
        customer: meta.customer,
        kitTags: meta.kit,
        notes: meta.notes,
        orderKey: meta.orderKey,
      });
      return res.status(201).json({ ok: true, file });
    } catch (error) {
      if (error instanceof DriveReconnectError) {
        return fail(409, "Reconnect Google Drive.", { reconnect: true });
      }
      const raw = error instanceof Error ? error.message : "";
      const message = raw && !/token|bearer|ya29|refresh/i.test(raw) ? raw : "Drive upload failed.";
      return fail(502, message);
    }
  });
}
