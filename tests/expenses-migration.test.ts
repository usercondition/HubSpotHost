import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { getSqlite, resetOrderLinkStore } from "../server/lib/order-links";

test("pre-recurring expenses table migrates without crashing on startup", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "exp-mig-")), "old.db");
  const old = new Database(file);
  old.exec(`CREATE TABLE expenses (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, vendor TEXT NOT NULL, name TEXT NOT NULL,
    category TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
    usd_amount_cents INTEGER, cadence TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT,
    payment_count INTEGER, payment_note TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  old.close();
  const prev = process.env.ORDER_LINKS_DB_FILE;
  resetOrderLinkStore();
  process.env.ORDER_LINKS_DB_FILE = file;
  try {
    const cols = (getSqlite().prepare("PRAGMA table_info(expenses)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes("recurring_expense_id"));
  } finally {
    resetOrderLinkStore();
    if (prev === undefined) delete process.env.ORDER_LINKS_DB_FILE; else process.env.ORDER_LINKS_DB_FILE = prev;
  }
});
