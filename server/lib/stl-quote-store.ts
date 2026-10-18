/**
 * STL Quote settings persisted in the main Print Ops SQLite file (same
 * volume as intake/plates). One JSON row; defaults when nothing is saved.
 */
import { DEFAULT_STL_QUOTE_SETTINGS, normalizeStlQuoteSettings, type StlQuoteSettings } from "../../shared/stl-quote";
import { getSqlite } from "./order-links";

let ready = false;
function ensure() {
  if (ready) return;
  getSqlite().exec(`CREATE TABLE IF NOT EXISTS stl_quote_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  ready = true;
}

export function getStlQuoteSettings(): { settings: StlQuoteSettings; updatedAt: string | null } {
  ensure();
  const row = getSqlite().prepare("SELECT settings_json, updated_at FROM stl_quote_settings WHERE id = 1").get() as
    | { settings_json: string; updated_at: string }
    | undefined;
  if (!row) return { settings: DEFAULT_STL_QUOTE_SETTINGS, updatedAt: null };
  try {
    return { settings: normalizeStlQuoteSettings(JSON.parse(row.settings_json)), updatedAt: row.updated_at };
  } catch {
    return { settings: DEFAULT_STL_QUOTE_SETTINGS, updatedAt: null };
  }
}

export function saveStlQuoteSettings(input: unknown): { settings: StlQuoteSettings; updatedAt: string } {
  ensure();
  const settings = normalizeStlQuoteSettings(input);
  const updatedAt = new Date().toISOString();
  getSqlite()
    .prepare(
      `INSERT INTO stl_quote_settings (id, settings_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
    )
    .run(JSON.stringify(settings), updatedAt);
  return { settings, updatedAt };
}

export function resetStlQuoteSettings(): { settings: StlQuoteSettings; updatedAt: null } {
  ensure();
  getSqlite().prepare("DELETE FROM stl_quote_settings WHERE id = 1").run();
  return { settings: DEFAULT_STL_QUOTE_SETTINGS, updatedAt: null };
}
