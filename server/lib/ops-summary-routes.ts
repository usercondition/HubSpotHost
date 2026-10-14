/**
 * GET /api/ops/orders-summary — read-only, PII-free order summary for the
 * internal Mac "Nerve" dashboard.
 *
 * Auth: Authorization: Bearer <NERVE_READ_TOKEN>. Disabled (503) when the env
 * var is unset. Wrong or missing token is 401. Compare is constant-time.
 *
 * Returns counts plus a ship-by list of {date, stage, status} only. No buyer
 * names, emails, addresses, deal IDs, payment data, or other PII.
 *
 * No writes: loads the production queue with address enrichment and HubSpot
 * stage refresh both off.
 */
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ProductionQueueItem, ProductionQueueResponse } from "../../shared/schema";
import { shipByCalendarDate } from "../../shared/ship-by";
import { loadProductionQueue } from "./queue-loader";

export type NerveShipByStatus = ProductionQueueItem["bucket"];

export type NerveShipByRow = {
  date: string;
  stage: string | null;
  status: NerveShipByStatus;
};

export type NerveOrdersSummary = {
  ok: true;
  generatedAt: string;
  today: string;
  openOrders: number;
  overdue: number;
  dueToday: number;
  shipBy: NerveShipByRow[];
};

type LoadQueue = (options?: {
  enrichAddresses?: boolean;
  refreshStages?: boolean;
}) => Promise<ProductionQueueResponse>;

export function nerveReadToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.NERVE_READ_TOKEN?.trim() || "";
}

function providedNerveToken(req: Request): string {
  return (req.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
}

/** Hash both sides so the compare is constant-time regardless of length. */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Returns true (and responds) when the Nerve token is unset, missing, or wrong. */
export function rejectNerveRead(
  req: Request,
  res: Response,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const expected = nerveReadToken(env);
  if (!expected) {
    res.status(503).json({ ok: false, error: "NERVE_READ_TOKEN not configured" });
    return true;
  }
  const provided = providedNerveToken(req);
  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return true;
  }
  return false;
}

export function openQueueItems(queue: ProductionQueueResponse): ProductionQueueItem[] {
  return [...queue.nextPrint, ...queue.inProduction, ...queue.shipReady, ...queue.blocked];
}

export function buildOrdersSummary(
  queue: ProductionQueueResponse,
  now: Date = new Date(),
): NerveOrdersSummary {
  const today = shipByCalendarDate(now);
  const open = openQueueItems(queue);
  const shipBy = open
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.shipBy))
    .map((item) => ({
      date: item.shipBy,
      stage: item.stage?.trim() ? item.stage.trim() : null,
      status: item.bucket,
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        String(a.stage ?? "").localeCompare(String(b.stage ?? "")) ||
        a.status.localeCompare(b.status),
    );

  return {
    ok: true,
    generatedAt: queue.generatedAt,
    today,
    openOrders: open.length,
    overdue: shipBy.filter((row) => row.date < today).length,
    dueToday: shipBy.filter((row) => row.date === today).length,
    shipBy,
  };
}

export function registerOpsSummaryRoutes(
  app: Express,
  options?: {
    loadQueue?: LoadQueue;
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
  },
): void {
  const loadQueue = options?.loadQueue ?? loadProductionQueue;
  const env = options?.env ?? process.env;
  const now = options?.now ?? (() => new Date());

  app.get("/api/ops/orders-summary", async (req: Request, res: Response) => {
    if (rejectNerveRead(req, res, env)) return;
    try {
      const queue = await loadQueue({ enrichAddresses: false, refreshStages: false });
      res.set("cache-control", "no-store");
      return res.json(buildOrdersSummary(queue, now()));
    } catch {
      return res.status(502).json({ ok: false, error: "could not build summary" });
    }
  });
}
