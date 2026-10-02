import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousDbFile = process.env.ORDER_LINKS_DB_FILE;
const dbFile = path.join(os.tmpdir(), `plate-download-tickets-${crypto.randomUUID()}.db`);
process.env.ORDER_LINKS_DB_FILE = dbFile;
const { getSqlite, resetOrderLinkStore } = await import("../server/lib/order-links");
const { readDownloadTicket, saveDownloadTicket } = await import("../server/lib/plate-files");

test.after(() => {
  resetOrderLinkStore();
  if (previousDbFile === undefined) delete process.env.ORDER_LINKS_DB_FILE;
  else process.env.ORDER_LINKS_DB_FILE = previousDbFile;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* test cleanup */
    }
  }
});

test("download tickets store only a hash and consume once", () => {
  const ticket = saveDownloadTicket("drive-file");
  const row = getSqlite()
    .prepare(`SELECT token_hash FROM plate_download_tickets`)
    .get() as { token_hash: string };

  assert.equal(row.token_hash, crypto.createHash("sha256").update(ticket.token).digest("hex"));
  assert.notEqual(row.token_hash, ticket.token);
  assert.equal(readDownloadTicket(ticket.token), "drive-file");
  assert.equal(readDownloadTicket(ticket.token), null);
});

test("expired download tickets are rejected", () => {
  const issuedAt = new Date("2026-10-02T16:00:00.000Z");
  const ticket = saveDownloadTicket("expired-file", issuedAt);

  assert.equal(readDownloadTicket(ticket.token, new Date("2026-10-02T16:06:00.000Z")), null);
});
