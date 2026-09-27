/**
 * Miguel's personal Google Drive. Service accounts cannot own those files.
 * The refresh token stays in SQLite, encrypted with the OAuth client secret.
 * Tokens are never logged.
 */
import crypto from "node:crypto";
import type { Readable } from "node:stream";
import { DRIVE_FILE_SCOPE, GOOGLE_OAUTH_CALLBACK_PATH } from "../../shared/plate-files";
import { getSqlite } from "./order-links";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,size,modifiedTime,mimeType";
const CHUNK_BYTES = 8 * 1024 * 1024;

type FetchImpl = typeof fetch;
let driveFetch: FetchImpl = fetch;

export function setDriveFetchForTest(next: FetchImpl | null): void {
  driveFetch = next ?? fetch;
}

export function googleDriveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID?.trim() && env.GOOGLE_OAUTH_CLIENT_SECRET?.trim());
}

export function googleRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${GOOGLE_OAUTH_CALLBACK_PATH}`;
}

function clientId(env: NodeJS.ProcessEnv): string {
  return env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "";
}

function clientSecret(env: NodeJS.ProcessEnv): string {
  return env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "";
}

function encryptionKey(secret: string): Buffer {
  return crypto.scryptSync(secret, "print-ops-google-drive-v1", 32);
}

export function encryptRefreshToken(token: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64url");
}

export function decryptRefreshToken(payload: string, secret: string): string {
  const raw = Buffer.from(payload, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export interface DriveConnectionStatus {
  configured: boolean;
  connected: boolean;
  email: string;
  reconnect: boolean;
}

type ConnectionRow = { email: string; refresh_token_enc: string; status: string };

function readConnection(): ConnectionRow | null {
  const row = getSqlite().prepare(`SELECT email, refresh_token_enc, status FROM google_drive_connection WHERE id = 1`).get() as
    | ConnectionRow
    | undefined;
  return row ?? null;
}

export function driveConnectionStatus(env: NodeJS.ProcessEnv = process.env): DriveConnectionStatus {
  const configured = googleDriveConfigured(env);
  const row = readConnection();
  if (!row) return { configured, connected: false, email: "", reconnect: false };
  const reconnect = row.status === "reconnect";
  return { configured, connected: !reconnect && Boolean(row.refresh_token_enc), email: row.email, reconnect };
}

function markReconnect(): void {
  getSqlite().prepare(`UPDATE google_drive_connection SET status = 'reconnect', updated_at = ? WHERE id = 1`).run(new Date().toISOString());
}

export function saveDriveConnection(input: { email: string; refreshToken: string }, env: NodeJS.ProcessEnv = process.env): void {
  const secret = clientSecret(env);
  if (!secret) throw new Error("Google Drive is not configured");
  const now = new Date().toISOString();
  getSqlite()
    .prepare(
      `INSERT INTO google_drive_connection (id, email, refresh_token_enc, status, updated_at)
       VALUES (1, ?, ?, 'connected', ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, refresh_token_enc = excluded.refresh_token_enc, status = 'connected', updated_at = excluded.updated_at`,
    )
    .run(input.email, encryptRefreshToken(input.refreshToken, secret), now);
}

export function disconnectDrive(): void {
  getSqlite().prepare(`DELETE FROM google_drive_connection WHERE id = 1`).run();
}

export function beginGoogleOauth(origin: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!googleDriveConfigured(env)) throw new Error("Google Drive is not configured");
  const state = crypto.randomBytes(24).toString("base64url");
  const now = new Date().toISOString();
  const sqlite = getSqlite();
  sqlite.prepare(`DELETE FROM google_oauth_states WHERE created_at < ?`).run(new Date(Date.now() - 15 * 60 * 1000).toISOString());
  sqlite.prepare(`INSERT INTO google_oauth_states (state, created_at) VALUES (?, ?)`).run(state, now);
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId(env));
  url.searchParams.set("redirect_uri", googleRedirectUri(origin));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DRIVE_FILE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);
  return url.toString();
}

function consumeOauthState(state: string): boolean {
  const sqlite = getSqlite();
  const row = sqlite.prepare(`SELECT state FROM google_oauth_states WHERE state = ?`).get(state) as { state: string } | undefined;
  if (!row) return false;
  sqlite.prepare(`DELETE FROM google_oauth_states WHERE state = ?`).run(state);
  return true;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function tokenError(body: Record<string, unknown>): string {
  const code = typeof body.error === "string" ? body.error : "";
  if (code === "invalid_grant") return "invalid_grant";
  return code || "google_token_failed";
}

export async function finishGoogleOauth(input: { code: string; state: string; origin: string }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!consumeOauthState(input.state)) throw new Error("That Google connection link expired. Connect again from Settings.");
  const response = await driveFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: clientId(env),
      client_secret: clientSecret(env),
      redirect_uri: googleRedirectUri(input.origin),
      grant_type: "authorization_code",
    }),
  });
  const body = await readJson(response);
  if (!response.ok) throw new Error(tokenError(body) === "invalid_grant" ? "Google declined the connection. Connect again." : "Google did not return a token.");
  const refresh = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const access = typeof body.access_token === "string" ? body.access_token : "";
  if (!refresh || !access) throw new Error("Google did not return a refresh token. Connect again.");
  const email = await driveEmail(access);
  saveDriveConnection({ email, refreshToken: refresh }, env);
}

export class DriveReconnectError extends Error {
  constructor() {
    super("Reconnect Google Drive.");
    this.name = "DriveReconnectError";
  }
}

async function accessToken(env: NodeJS.ProcessEnv): Promise<string> {
  const row = readConnection();
  const secret = clientSecret(env);
  if (!row || !secret || row.status === "reconnect") throw new DriveReconnectError();
  let refresh = "";
  try {
    refresh = decryptRefreshToken(row.refresh_token_enc, secret);
  } catch {
    markReconnect();
    throw new DriveReconnectError();
  }
  const response = await driveFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(env),
      client_secret: secret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    if (tokenError(body) === "invalid_grant") {
      markReconnect();
      throw new DriveReconnectError();
    }
    throw new Error("Google Drive did not refresh. Try again.");
  }
  const access = typeof body.access_token === "string" ? body.access_token : "";
  if (!access) throw new Error("Google Drive did not refresh. Try again.");
  return access;
}

async function driveEmail(access: string): Promise<string> {
  const response = await driveFetch(`${DRIVE_API}/about?fields=user(emailAddress)`, {
    headers: { authorization: `Bearer ${access}` },
  });
  if (!response.ok) return "";
  const body = await readJson(response);
  const user = body.user as { emailAddress?: string } | undefined;
  return typeof user?.emailAddress === "string" ? user.emailAddress : "";
}

async function findFolder(access: string, name: string, parentId: string | null): Promise<string | null> {
  const parent = parentId ? ` and '${parentId}' in parents` : " and 'root' in parents";
  const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parent}`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`;
  const response = await driveFetch(url, { headers: { authorization: `Bearer ${access}` } });
  if (!response.ok) throw new Error("Could not open the Print Ops folder in Drive.");
  const body = await readJson(response);
  const files = Array.isArray(body.files) ? body.files : [];
  const first = files[0] as { id?: string } | undefined;
  return typeof first?.id === "string" ? first.id : null;
}

async function createFolder(access: string, name: string, parentId: string | null): Promise<string> {
  const response = await driveFetch(`${DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.id !== "string") throw new Error("Could not create the Print Ops folder in Drive.");
  return body.id;
}

const folderJobs = new Map<string, Promise<string>>();

async function ensureFolder(access: string, name: string, parentId: string | null): Promise<string> {
  const key = `${parentId ?? "root"}:${name}`;
  const existing = folderJobs.get(key);
  if (existing) return existing;
  const job = (async () => {
    const found = await findFolder(access, name, parentId);
    if (found) return found;
    return createFolder(access, name, parentId);
  })().finally(() => {
    folderJobs.delete(key);
  });
  folderJobs.set(key, job);
  return job;
}

export async function ensureOrderFolder(folderName: string, env: NodeJS.ProcessEnv = process.env): Promise<{ access: string; folderId: string }> {
  const access = await accessToken(env);
  const root = await ensureFolder(access, "Print Ops", null);
  const folderId = await ensureFolder(access, folderName, root);
  return { access, folderId };
}

export interface DriveUploadedFile {
  id: string;
  name: string;
  webViewLink: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  mimeType: string;
}

async function* chunksOf(stream: Readable, size: number): AsyncGenerator<Buffer> {
  let pending = Buffer.alloc(0);
  for await (const piece of stream) {
    const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
    while (pending.length >= size) {
      yield pending.subarray(0, size);
      pending = pending.subarray(size);
    }
  }
  if (pending.length > 0) yield pending;
}

async function putChunk(session: string, chunk: Buffer, start: number, total: number): Promise<{ done: boolean; file?: Record<string, unknown> }> {
  let lastError = "Drive upload stalled.";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await driveFetch(session, {
        method: "PUT",
        headers: {
          "content-length": String(chunk.length),
          "content-range": `bytes ${start}-${start + chunk.length - 1}/${total}`,
        },
        body: new Uint8Array(chunk),
      });
    } catch {
      lastError = "Drive upload stalled.";
      continue;
    }
    if (response.status === 308) return { done: false };
    if (response.ok) return { done: true, file: await readJson(response) };
    lastError = `Drive upload failed (${response.status}).`;
  }
  throw new Error(lastError);
}

export class DriveUnreadableError extends Error {
  constructor() {
    super("Drive could not read that file.");
    this.name = "DriveUnreadableError";
  }
}

/** Stream a file this app created. Forwards Range so large plates are not buffered. */
export async function openDriveMedia(fileId: string, range: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  const access = await accessToken(env);
  const headers: Record<string, string> = { authorization: `Bearer ${access}` };
  if (range) headers.range = range;
  const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers });
  if (response.status === 401 || response.status === 403) throw new DriveReconnectError();
  if (response.status === 404) throw new DriveUnreadableError();
  return response;
}

export async function uploadDriveFile(input: {
  access: string;
  folderId: string;
  name: string;
  size: number;
  body: Readable;
  /** First bytes, for a thumbnail. Must not retain the whole plate. */
  onPrefix?: (chunk: Buffer, offset: number) => void;
}): Promise<DriveUploadedFile> {
  const start = await driveFetch(DRIVE_UPLOAD, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.access}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": "application/octet-stream",
      "x-upload-content-length": String(input.size),
    },
    body: JSON.stringify({ name: input.name, parents: [input.folderId] }),
  });
  if (!start.ok) throw new Error("Drive did not start the upload.");
  const session = start.headers.get("location");
  if (!session) throw new Error("Drive did not start the upload.");
  let offset = 0;
  let file: Record<string, unknown> | undefined;
  for await (const chunk of chunksOf(input.body, CHUNK_BYTES)) {
    input.onPrefix?.(chunk, offset);
    const result = await putChunk(session, chunk, offset, input.size);
    offset += chunk.length;
    if (result.done) file = result.file;
  }
  if (offset !== input.size || !file || typeof file.id !== "string") {
    throw new Error("Drive did not confirm the file.");
  }
  const sizeRaw = typeof file.size === "string" ? Number(file.size) : null;
  return {
    id: file.id,
    name: typeof file.name === "string" ? file.name : input.name,
    webViewLink: typeof file.webViewLink === "string" ? file.webViewLink : `https://drive.google.com/file/d/${file.id}/view`,
    sizeBytes: Number.isFinite(sizeRaw) ? sizeRaw : input.size,
    modifiedAt: typeof file.modifiedTime === "string" ? file.modifiedTime : null,
    mimeType: typeof file.mimeType === "string" ? file.mimeType : "application/octet-stream",
  };
}
