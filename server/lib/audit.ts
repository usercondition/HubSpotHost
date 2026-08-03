/**
 * Local-file audit log. Retains the most recent 100 attempts.
 *
 * Deliberately narrow: no raw webhook payloads, no headers, no tokens, no
 * customer-identifying deal data — only the numbers used in the calculation,
 * the outcome, and a short error string when something failed.
 */
import type { CalcResult } from "./calc";
import fs from "node:fs";
import path from "node:path";

export const AUDIT_LIMIT = 100;

export type TriggerOrigin = "webhook" | "manual";
export type AttemptStatus = "written" | "dry-run" | "error";

export interface AuditEntry {
  id: number;
  timestamp: string;
  dealId: string;
  origin: TriggerOrigin;
  status: AttemptStatus;
  /** True when the attempt intentionally skipped the HubSpot PATCH. */
  dryRun: boolean;
  /** Why the write was or was not performed. */
  gate: string;
  inputs: {
    amount: number;
    material: number;
    labor: number;
    packaging: number;
    shipping: number;
    costTotal: number;
  } | null;
  outputs: {
    print_gross_profit: number;
    print_margin_percentage: number;
  } | null;
  error?: string;
}

let nextId = 1;
const auditFile = process.env.AUDIT_LOG_FILE?.trim()
  ? path.resolve(process.env.AUDIT_LOG_FILE)
  : path.resolve(process.cwd(), "data", "audit-log.json");

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<AuditEntry>;
  return (
    typeof entry.id === "number" &&
    typeof entry.timestamp === "string" &&
    typeof entry.dealId === "string" &&
    typeof entry.origin === "string" &&
    typeof entry.status === "string" &&
    typeof entry.dryRun === "boolean" &&
    typeof entry.gate === "string"
  );
}

function loadEntries(): AuditEntry[] {
  try {
    const raw = fs.readFileSync(auditFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAuditEntry).slice(0, AUDIT_LIMIT);
  } catch {
    return [];
  }
}

const entries: AuditEntry[] = loadEntries();
if (entries.length > 0) {
  nextId = Math.max(...entries.map((entry) => entry.id)) + 1;
}

function persistEntries(): void {
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.writeFileSync(auditFile, JSON.stringify(entries, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
    // Audit persistence must never prevent a calculation attempt from completing.
    // The in-process log remains available if the local volume is unavailable.
  }
}

export function recordAttempt(input: {
  dealId: string;
  origin: TriggerOrigin;
  status: AttemptStatus;
  dryRun: boolean;
  gate: string;
  calc?: CalcResult | null;
  error?: string;
}): AuditEntry {
  const entry: AuditEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    dealId: input.dealId,
    origin: input.origin,
    status: input.status,
    dryRun: input.dryRun,
    gate: input.gate,
    inputs: input.calc
      ? {
          amount: input.calc.amount,
          material: input.calc.material,
          labor: input.calc.labor,
          packaging: input.calc.packaging,
          shipping: input.calc.shipping,
          costTotal: input.calc.costTotal,
        }
      : null,
    outputs: input.calc
      ? {
          print_gross_profit: input.calc.grossProfit,
          print_margin_percentage: input.calc.marginPercentage,
        }
      : null,
  };
  if (input.error) {
    entry.error = truncateError(input.error);
  }

  entries.unshift(entry);
  if (entries.length > AUDIT_LIMIT) entries.length = AUDIT_LIMIT;
  persistEntries();
  return entry;
}

/** Keep errors short and free of payload/credential detail. */
export function truncateError(message: string, max = 140): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function listAttempts(limit = AUDIT_LIMIT): AuditEntry[] {
  return entries.slice(0, Math.min(limit, AUDIT_LIMIT));
}

export function auditCount(): number {
  return entries.length;
}

export function resetAudit(): void {
  entries.length = 0;
  nextId = 1;
  persistEntries();
}
