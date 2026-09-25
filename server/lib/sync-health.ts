/**
 * Compare HubSpot Print Orders with Print Ops local state and report drift.
 * Health reads a cache. The owner route returns the per-deal detail.
 */
import { shopWeekEnd, shopWeekStart } from "../../shared/priority-stack";
import { printOrderStageLooksArchived, type HubspotSyncSummary } from "../../shared/schema";
import { shipByCalendarDate } from "../../shared/ship-by";
import { listAttempts, type AuditEntry } from "./audit";
import { getConfig, resolveWriteDecision } from "./config";
import { updateShipByPlan } from "./deal-ops";
import { fetchPrintOrderDeals, fetchPrintOrderPipelineStages, HubSpotError } from "./hubspot";
import { getDb } from "./order-links";
import { fulfillmentChecklists } from "../../shared/schema";
import { listStackState } from "./priority-stack";
import { loadProductionQueue } from "./queue-loader";
import { recalculateDeal } from "./service";
import { getLatestWebhookDiagnostic, type WebhookDiagnostic } from "./webhook-diagnostics";

const INTERVAL_MS = 15 * 60 * 1000;
const WEBHOOK_FRESH_MS = 24 * 60 * 60 * 1000;

export const SYNC_DRIFT_KINDS = [
  "missingInOps",
  "orphans",
  "tracking",
  "shipNotes",
  "shipBy",
  "costs",
  "amount",
  "doneStillOpen",
  "closedNotDone",
  "failedWrites",
  "webhook",
  "token",
] as const;

export type SyncDriftKind = (typeof SYNC_DRIFT_KINDS)[number];

export interface SyncDriftItem {
  kind: SyncDriftKind;
  dealId: string | null;
  field: string | null;
  local: string | null;
  hubspot: string | null;
  repairable: boolean;
  suggestedFix: string;
}

export interface SyncRepair {
  dealId: string;
  field: "tracking" | "notes" | "ship_by" | "retry";
  value: string;
}

export type { HubspotSyncSummary };

export interface SyncHealthReport {
  ok: true;
  summary: HubspotSyncSummary;
  items: SyncDriftItem[];
  repairs: SyncRepair[];
}

export interface SyncHubspotDeal {
  dealId: string;
  found: boolean;
  stage: string;
  closed: boolean;
  closedWon: boolean;
  amount: string;
  tracking: string;
  shipNotes: string;
  shipBy: string;
  material: string;
  labor: string;
  packaging: string;
  shipping: string;
}

export interface SyncLocalDeal {
  dealId: string;
  inQueue: boolean;
  inStack: boolean;
  bundleMember: boolean;
  amount: string | null;
  tracking: string;
  shipNotes: string;
  shipBy: string | null;
  shipBySource: string | null;
  material: string | null;
  labor: string | null;
  packaging: string | null;
  shipping: string | null;
  doneAt: string | null;
}

export interface SyncCompareInput {
  openDealIds: string[];
  hubspotById: Record<string, SyncHubspotDeal>;
  localDeals: SyncLocalDeal[];
  audit: AuditEntry[];
  webhookConfigured: boolean;
  webhook: WebhookDiagnostic | null;
  tokenError: string | null;
  lastSuccessfulReadAt: string | null;
  lastSuccessfulWriteAt: string | null;
  now?: Date;
}

function emptyCounts(): Record<SyncDriftKind, number> {
  return {
    missingInOps: 0,
    orphans: 0,
    tracking: 0,
    shipNotes: 0,
    shipBy: 0,
    costs: 0,
    amount: 0,
    doneStillOpen: 0,
    closedNotDone: 0,
    failedWrites: 0,
    webhook: 0,
    token: 0,
  };
}

function blank(value: string | null | undefined): boolean {
  return !String(value ?? "").trim();
}

function sameText(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

function sameMoney(left: string, right: string): boolean {
  const a = Number(left.replace(/[$,]/g, ""));
  const b = Number(right.replace(/[$,]/g, ""));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return sameText(left, right);
  return Math.abs(a - b) < 0.009;
}

function dayKey(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return shipByCalendarDate(parsed);
}

function doneThisWeek(doneAt: string | null, now: Date): boolean {
  if (!doneAt) return false;
  const day = dayKey(doneAt);
  return day >= shopWeekStart(now) && day <= shopWeekEnd(now);
}

function item(
  kind: SyncDriftKind,
  dealId: string | null,
  field: string | null,
  local: string | null,
  hubspot: string | null,
  repairable: boolean,
  suggestedFix: string,
): SyncDriftItem {
  return { kind, dealId, field, local, hubspot, repairable, suggestedFix };
}

function webhookNote(configured: boolean, latest: WebhookDiagnostic | null, now: Date): { arriving: boolean; note: string } {
  if (!configured) {
    return {
      arriving: false,
      note: "HubSpot webhooks are not configured. Print Ops will not hear about deal changes until a webhook subscription is set.",
    };
  }
  if (!latest) {
    return {
      arriving: false,
      note: "Webhooks are configured, but none have arrived since this server started.",
    };
  }
  const age = now.getTime() - new Date(latest.receivedAt).getTime();
  if (!Number.isFinite(age) || age > WEBHOOK_FRESH_MS) {
    return {
      arriving: false,
      note: "Webhooks are configured, but the last delivery is more than a day old.",
    };
  }
  return { arriving: true, note: "HubSpot webhooks are arriving." };
}

export function compareSyncHealth(input: SyncCompareInput): SyncHealthReport {
  const now = input.now ?? new Date();
  const items: SyncDriftItem[] = [];
  const repairs: SyncRepair[] = [];
  const localIds = new Set(input.localDeals.map((deal) => deal.dealId));
  const hubspot = input.hubspotById;

  for (const dealId of input.openDealIds) {
    const remote = hubspot[dealId];
    if (!remote || remote.closed || localIds.has(dealId)) continue;
    items.push(item(
      "missingInOps",
      dealId,
      null,
      null,
      remote.stage || "open",
      false,
      "This open HubSpot deal is not on the Queue or the Stack. Open it in Print Ops, or close it in HubSpot if it is not a print job.",
    ));
  }

  for (const local of input.localDeals) {
    const remote = hubspot[local.dealId];
    const referenced = local.inQueue || local.inStack;
    if (referenced && (!remote || !remote.found)) {
      items.push(item(
        "orphans",
        local.dealId,
        null,
        local.inStack ? "stack" : "queue",
        "not found",
        false,
        "Print Ops still has this deal, but HubSpot does not. Remove the local row if the deal was deleted.",
      ));
    } else if (referenced && remote?.closed && !remote.closedWon) {
      items.push(item(
        "orphans",
        local.dealId,
        "stage",
        local.inStack ? "stack" : "queue",
        remote.stage,
        false,
        "This deal is closed in HubSpot but still sits on the Queue or Stack. It should leave the open boards.",
      ));
    }

    if (remote?.found && remote.closedWon && referenced && !doneThisWeek(local.doneAt, now)) {
      items.push(item(
        "closedNotDone",
        local.dealId,
        "stage",
        local.doneAt,
        remote.stage,
        false,
        "HubSpot has this deal Completed or Closed Won, but the Stack has not marked it done this week.",
      ));
    }

    if (remote?.found && !remote.closed && doneThisWeek(local.doneAt, now)) {
      items.push(item(
        "doneStillOpen",
        local.dealId,
        "stage",
        local.doneAt,
        remote.stage,
        false,
        "The Stack marked this done, but HubSpot still has it in an open stage. Picked up and labels should move it to Completed when writes are on.",
      ));
    }

    if (!remote?.found) continue;

    if (!blank(local.tracking) || !blank(remote.tracking)) {
      if (!blank(local.tracking) && blank(remote.tracking)) {
        items.push(item("tracking", local.dealId, "print_tracking_number", local.tracking, "", true, "HubSpot tracking is blank. Print Ops can push the local tracking number."));
        repairs.push({ dealId: local.dealId, field: "tracking", value: local.tracking });
      } else if (blank(local.tracking) && !blank(remote.tracking)) {
        items.push(item("tracking", local.dealId, "print_tracking_number", "", remote.tracking, false, "HubSpot has a tracking number and Print Ops does not. Not overwritten."));
      } else if (!sameText(local.tracking, remote.tracking)) {
        items.push(item("tracking", local.dealId, "print_tracking_number", local.tracking, remote.tracking, false, "Tracking differs. HubSpot’s value is left as-is."));
      }
    }

    if (!blank(local.shipNotes) || !blank(remote.shipNotes)) {
      if (!blank(local.shipNotes) && blank(remote.shipNotes)) {
        items.push(item("shipNotes", local.dealId, "print_ship_notes", local.shipNotes, "", true, "HubSpot ship notes are blank. Print Ops can push the local notes."));
        repairs.push({ dealId: local.dealId, field: "notes", value: local.shipNotes });
      } else if (blank(local.shipNotes) && !blank(remote.shipNotes)) {
        items.push(item("shipNotes", local.dealId, "print_ship_notes", "", remote.shipNotes, false, "HubSpot has ship notes and Print Ops does not. Not overwritten."));
      } else if (!sameText(local.shipNotes, remote.shipNotes)) {
        items.push(item("shipNotes", local.dealId, "print_ship_notes", local.shipNotes, remote.shipNotes, false, "Ship notes differ. HubSpot’s value is left as-is."));
      }
    }

    if (!local.doneAt && (local.shipBy || !blank(remote.shipBy))) {
      const localDay = dayKey(local.shipBy);
      const remoteDay = dayKey(remote.shipBy);
      const who = local.bundleMember ? "Bundle member ship-by" : "Ship-by";
      if (!blank(localDay) && blank(remoteDay)) {
        items.push(item("shipBy", local.dealId, "print_ship_by", localDay, "", true, `${who} is set in Print Ops and blank in HubSpot. Print Ops can push that date.`));
        repairs.push({ dealId: local.dealId, field: "ship_by", value: localDay });
      } else if (blank(localDay) && !blank(remoteDay)) {
        items.push(item("shipBy", local.dealId, "print_ship_by", "", remoteDay, false, `${who} is set in HubSpot and blank on the Stack. Not overwritten.`));
      } else if (!blank(localDay) && !blank(remoteDay) && localDay !== remoteDay) {
        items.push(item("shipBy", local.dealId, "print_ship_by", localDay, remoteDay, false, `${who} dates differ. HubSpot’s date is left as-is.`));
      }
    }

    const costPairs: Array<[string, string | null, string]> = [
      ["print_material_cost", local.material, remote.material],
      ["print_labor_cost", local.labor, remote.labor],
      ["print_packaging_cost", local.packaging, remote.packaging],
      ["print_actual_shipping_cost", local.shipping, remote.shipping],
    ];
    for (const [field, localValue, remoteValue] of costPairs) {
      if (localValue == null || blank(localValue)) continue;
      if (blank(remoteValue) || !sameMoney(localValue, remoteValue)) {
        items.push(item(
          "costs",
          local.dealId,
          field,
          localValue,
          remoteValue,
          false,
          blank(remoteValue)
            ? "HubSpot cost is blank. Reported only — cost fields are not auto-filled from the audit log."
            : "Cost differs from the last Print Ops write. HubSpot’s value is left as-is.",
        ));
      }
    }

    if (local.amount != null && !blank(remote.amount) && !sameMoney(local.amount, remote.amount)) {
      items.push(item(
        "amount",
        local.dealId,
        "amount",
        local.amount,
        remote.amount,
        false,
        "Stack total uses a different amount than HubSpot. Reported only.",
      ));
    }
  }

  const latestByDeal = new Map<string, AuditEntry>();
  for (const entry of input.audit) {
    const current = latestByDeal.get(entry.dealId);
    if (!current || entry.timestamp > current.timestamp) latestByDeal.set(entry.dealId, entry);
  }
  for (const entry of latestByDeal.values()) {
    if (entry.status !== "error") continue;
    items.push(item(
      "failedWrites",
      entry.dealId,
      "audit",
      entry.gate,
      entry.error ?? "error",
      true,
      "The last HubSpot write for this deal failed. Print Ops can retry that recalculation.",
    ));
    repairs.push({ dealId: entry.dealId, field: "retry", value: "" });
  }

  if (input.tokenError) {
    items.push(item("token", null, "hubspot", null, null, false, "HubSpot rejected the connection. Check the private-app token and API base."));
  }

  const webhook = webhookNote(input.webhookConfigured, input.webhook, now);
  if (input.webhookConfigured && !webhook.arriving) {
    items.push(item("webhook", null, "webhook", input.webhook?.receivedAt ?? null, null, false, webhook.note));
  }

  const counts = emptyCounts();
  for (const row of items) counts[row.kind] += 1;
  const issueCount = items.length;
  const status = input.tokenError ? "error" : issueCount > 0 ? "warn" : "ok";

  return {
    ok: true,
    summary: {
      status,
      counts,
      issueCount,
      lastSuccessfulReadAt: input.lastSuccessfulReadAt,
      lastSuccessfulWriteAt: input.lastSuccessfulWriteAt,
      lastCheckedAt: now.toISOString(),
      webhook: {
        configured: input.webhookConfigured,
        arriving: webhook.arriving,
        lastDeliveryAt: input.webhook?.receivedAt ?? null,
        note: webhook.note,
      },
    },
    items,
    repairs,
  };
}

let cached: SyncHealthReport | null = null;
let running: Promise<SyncHealthReport> | null = null;
let scheduleStarted = false;

export function getCachedSyncHealth(): SyncHealthReport | null {
  return cached;
}

export function setCachedSyncHealth(report: SyncHealthReport): void {
  cached = report;
}

export function placeholderSyncSummary(now = new Date()): HubspotSyncSummary {
  const config = getConfig();
  const webhook = webhookNote(config.webhookSecretConfigured, getLatestWebhookDiagnostic(), now);
  const note = webhook.note.startsWith("HubSpot webhooks are not configured")
    ? `${webhook.note} Sync check has not run yet.`
    : "Sync check has not run yet.";
  return {
    status: "ok",
    counts: emptyCounts(),
    issueCount: 0,
    lastSuccessfulReadAt: null,
    lastSuccessfulWriteAt: null,
    lastCheckedAt: null,
    webhook: {
      configured: config.webhookSecretConfigured,
      arriving: webhook.arriving,
      lastDeliveryAt: getLatestWebhookDiagnostic()?.receivedAt ?? null,
      note,
    },
  };
}

export function clearCachedSyncHealthForTest(): void {
  cached = null;
}

function latestWriteAt(audit: AuditEntry[]): string | null {
  let latest: string | null = null;
  for (const entry of audit) {
    if (entry.status !== "written") continue;
    if (!latest || entry.timestamp > latest) latest = entry.timestamp;
  }
  return latest;
}

function stageClosed(metadata: { isClosed?: string | boolean } | undefined, label: string, props: Record<string, string | null>): boolean {
  if (String(props.hs_is_closed ?? "").toLowerCase() === "true") return true;
  if (metadata?.isClosed === true || String(metadata?.isClosed ?? "").toLowerCase() === "true") return true;
  return printOrderStageLooksArchived(label);
}

function stageClosedWon(label: string, props: Record<string, string | null>, closed: boolean): boolean {
  if (String(props.hs_is_closed_won ?? "").toLowerCase() === "true") return true;
  if (!closed) return false;
  return /completed|closed\s*won|\bshipped\b/.test(label.toLowerCase());
}

export async function loadSyncCompareInput(now = new Date()): Promise<SyncCompareInput> {
  const [deals, stages, queue, state] = await Promise.all([
    fetchPrintOrderDeals(),
    fetchPrintOrderPipelineStages(),
    loadProductionQueue({ enrichAddresses: false, refreshStages: false }),
    Promise.resolve(listStackState()),
  ]);
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const hubspotById: Record<string, SyncHubspotDeal> = {};
  const openDealIds: string[] = [];
  for (const deal of deals) {
    const props = deal.properties;
    const stageId = String(props.dealstage ?? "");
    const stage = stageById.get(stageId);
    const label = stage?.label || stageId;
    const closed = stageClosed(stage?.metadata, label, props);
    const row: SyncHubspotDeal = {
      dealId: deal.id,
      found: true,
      stage: label,
      closed,
      closedWon: stageClosedWon(label, props, closed),
      amount: String(props.amount ?? ""),
      tracking: String(props.print_tracking_number ?? ""),
      shipNotes: String(props.print_ship_notes ?? ""),
      shipBy: String(props.print_ship_by ?? props.ship_by_date ?? ""),
      material: String(props.print_material_cost ?? ""),
      labor: String(props.print_labor_cost ?? ""),
      packaging: String(props.print_packaging_cost ?? ""),
      shipping: String(props.print_actual_shipping_cost ?? ""),
    };
    hubspotById[deal.id] = row;
    if (!closed) openDealIds.push(deal.id);
  }

  const checklists = new Map(
    getDb().select().from(fulfillmentChecklists).all().map((row) => [row.hubspotDealId, row]),
  );
  const audit = listAttempts();
  const latestAudit = new Map<string, AuditEntry>();
  for (const entry of audit) {
    const current = latestAudit.get(entry.dealId);
    if (!current || entry.timestamp > current.timestamp) latestAudit.set(entry.dealId, entry);
  }
  const items = [...queue.nextPrint, ...queue.inProduction, ...queue.blocked, ...queue.shipReady];
  const queueById = new Map(items.map((item) => [item.dealId, item]));
  const bundleIds = new Set(
    state.entries.filter((entry) => entry.kind === "deal" && entry.bundleId && entry.hubspotDealId).map((entry) => entry.hubspotDealId as string),
  );
  const local = new Map<string, SyncLocalDeal>();

  function ensure(dealId: string): SyncLocalDeal {
    const existing = local.get(dealId);
    if (existing) return existing;
    const checklist = checklists.get(dealId);
    const costs = latestAudit.get(dealId)?.inputs ?? null;
    const created: SyncLocalDeal = {
      dealId,
      inQueue: false,
      inStack: false,
      bundleMember: bundleIds.has(dealId),
      amount: null,
      tracking: checklist?.trackingNumber ?? "",
      shipNotes: checklist?.notes ?? "",
      shipBy: null,
      shipBySource: null,
      material: costs ? String(costs.material) : null,
      labor: costs ? String(costs.labor) : null,
      packaging: costs ? String(costs.packaging) : null,
      shipping: costs ? String(costs.shipping) : null,
      doneAt: null,
    };
    local.set(dealId, created);
    return created;
  }

  for (const item of items) {
    const row = ensure(item.dealId);
    row.inQueue = true;
    row.inStack = true;
    row.amount = String(item.amount);
    row.shipBy = item.shipBy;
    row.shipBySource = item.shipBySource;
  }
  for (const entry of state.entries) {
    if (entry.kind !== "deal" || !entry.hubspotDealId) continue;
    const row = ensure(entry.hubspotDealId);
    row.inStack = true;
    row.doneAt = entry.doneAt;
    if (row.amount == null && entry.doneAmount) row.amount = entry.doneAmount;
  }

  return {
    openDealIds,
    hubspotById,
    localDeals: [...local.values()],
    audit,
    webhookConfigured: getConfig().webhookSecretConfigured,
    webhook: getLatestWebhookDiagnostic(),
    tokenError: null,
    lastSuccessfulReadAt: now.toISOString(),
    lastSuccessfulWriteAt: latestWriteAt(audit),
    now,
  };
}

export async function applySyncRepairs(
  repairs: SyncRepair[],
): Promise<Array<{ dealId: string; field: string; wrote: boolean; dryRun: boolean; skipped?: "hubspot-not-blank" | "read-failed" }>> {
  const results: Array<{ dealId: string; field: string; wrote: boolean; dryRun: boolean; skipped?: "hubspot-not-blank" | "read-failed" }> = [];
  for (const repair of repairs) {
    const decision = resolveWriteDecision(getConfig(), true);
    if (!decision.write) {
      results.push({ dealId: repair.dealId, field: repair.field, wrote: false, dryRun: true });
      continue;
    }
    if (repair.field === "retry") {
      try {
        const outcome = await recalculateDeal({ dealId: repair.dealId, origin: "manual", requestWantsLiveWrite: true });
        results.push({ dealId: repair.dealId, field: repair.field, wrote: outcome.status === "written", dryRun: outcome.dryRun });
      } catch {
        results.push({ dealId: repair.dealId, field: repair.field, wrote: false, dryRun: false, skipped: "read-failed" });
      }
      continue;
    }
    const property = repair.field === "tracking"
      ? "print_tracking_number"
      : repair.field === "notes"
        ? "print_ship_notes"
        : "print_ship_by";
    let current = "";
    try {
      current = await readHubspotProperty(repair.dealId, property);
    } catch {
      results.push({ dealId: repair.dealId, field: repair.field, wrote: false, dryRun: false, skipped: "read-failed" });
      continue;
    }
    if (current) {
      results.push({ dealId: repair.dealId, field: repair.field, wrote: false, dryRun: false, skipped: "hubspot-not-blank" });
      continue;
    }
    if (repair.field === "ship_by") {
      const outcome = await updateShipByPlan(repair.dealId, { shipBy: repair.value, liveWrite: true });
      results.push({
        dealId: repair.dealId,
        field: repair.field,
        wrote: Boolean(outcome.ok && !outcome.dryRun),
        dryRun: Boolean(outcome.ok && outcome.dryRun),
      });
      continue;
    }
    const writable = repair.field === "tracking" ? "print_tracking_number" : "print_ship_notes";
    try {
      await pushOneField(repair.dealId, writable, repair.value);
      results.push({ dealId: repair.dealId, field: repair.field, wrote: true, dryRun: false });
    } catch {
      results.push({ dealId: repair.dealId, field: repair.field, wrote: false, dryRun: false, skipped: "read-failed" });
    }
  }
  return results;
}

async function readHubspotProperty(dealId: string, property: string): Promise<string> {
  const { hubspotRequest } = await import("./hubspot");
  const body = await hubspotRequest(
    `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(property)}`,
    { method: "GET" },
  );
  return String(body?.properties?.[property] ?? "").trim();
}

async function pushOneField(dealId: string, property: "print_tracking_number" | "print_ship_notes", value: string): Promise<void> {
  const { hubspotRequest } = await import("./hubspot");
  await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: { [property]: value } }),
  });
}

export async function runSyncHealthCheck(now = new Date()): Promise<SyncHealthReport> {
  if (running) return running;
  running = runSyncHealthCheckBody(now).finally(() => {
    running = null;
  });
  return running;
}

async function runSyncHealthCheckBody(now: Date): Promise<SyncHealthReport> {
  try {
    const input = await loadSyncCompareInput(now);
    const report = compareSyncHealth(input);
    if (report.repairs.length > 0) {
      try {
        const applied = await applySyncRepairs(report.repairs);
        const fixed = new Set(applied.filter((row) => row.wrote).map((row) => `${row.dealId}:${row.field}`));
        if (fixed.size > 0) {
          report.items = report.items.filter((row) => !fixed.has(`${row.dealId}:${repairFieldForKind(row.kind)}`));
          report.repairs = report.repairs.filter((row) => !fixed.has(`${row.dealId}:${row.field}`));
          recount(report);
        }
      } catch (error) {
        console.warn(`[sync-health] repair pass failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    cached = report;
    return report;
  } catch (error) {
    const tokenError = error instanceof HubSpotError ? error.message : error instanceof Error ? error.message : "HubSpot read failed";
    const report = compareSyncHealth({
      openDealIds: [],
      hubspotById: {},
      localDeals: [],
      audit: listAttempts(),
      webhookConfigured: getConfig().webhookSecretConfigured,
      webhook: getLatestWebhookDiagnostic(),
      tokenError,
      lastSuccessfulReadAt: cached?.summary.lastSuccessfulReadAt ?? null,
      lastSuccessfulWriteAt: latestWriteAt(listAttempts()),
      now,
    });
    cached = report;
    return report;
  }
}

function repairFieldForKind(kind: SyncDriftKind): string {
  if (kind === "tracking") return "tracking";
  if (kind === "shipNotes") return "notes";
  if (kind === "shipBy") return "ship_by";
  if (kind === "failedWrites") return "retry";
  return "";
}

function recount(report: SyncHealthReport): void {
  const counts = emptyCounts();
  for (const row of report.items) counts[row.kind] += 1;
  report.summary.counts = counts;
  report.summary.issueCount = report.items.length;
  report.summary.status = counts.token > 0 ? "error" : report.items.length > 0 ? "warn" : "ok";
}

function kickSyncHealthCheck(): void {
  void runSyncHealthCheck().catch((error) => {
    console.warn(`[sync-health] check failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export function startSyncHealthSchedule(): void {
  if (scheduleStarted) return;
  scheduleStarted = true;
  kickSyncHealthCheck();
  if (process.env.REDIS_URL?.trim()) {
    void import("./print-ops-jobs")
      .then((jobs) => jobs.scheduleSyncHealthJob())
      .catch((error) => {
        console.warn(`[sync-health] Redis schedule failed; using an in-process timer: ${error instanceof Error ? error.message : String(error)}`);
        const timer = setInterval(kickSyncHealthCheck, INTERVAL_MS);
        timer.unref?.();
      });
    return;
  }
  const timer = setInterval(kickSyncHealthCheck, INTERVAL_MS);
  timer.unref?.();
}
