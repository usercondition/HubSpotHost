/**
 * Redis-backed background work for Print Ops.
 *
 * BullMQ is used because it provides Redis persistence, retry/backoff, and
 * worker locking without adding another service. When REDIS_URL is unset, the
 * same handlers run synchronously so local development keeps its old behavior.
 */
import { createHash } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import {
  runMarketplaceShipNoteJob,
  runShipmentEmailJob,
  type BuyerEmailSend,
  type MarketplaceShipNoteJob,
  type ShipmentEmailJob,
} from "./shipment-notification-jobs";

const QUEUE_NAME = "print-ops";
const RETRY_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 10_000 },
  removeOnComplete: 1_000,
  removeOnFail: 1_000,
};

type SyncHealthJob = { kind: "sync-health" };
type PrintOpsJobName = "shipment-email" | "marketplace-ship-note" | "sync-health";
type PrintOpsJobData = ShipmentEmailJob | MarketplaceShipNoteJob | SyncHealthJob;

let queue: Queue<PrintOpsJobData, unknown, PrintOpsJobName> | null = null;
let worker: Worker<PrintOpsJobData, unknown, PrintOpsJobName> | null = null;
let startupAttempted = false;
let loggedRedisError = false;

function redisUrl(): string {
  return process.env.REDIS_URL?.trim() ?? "";
}

function logRedisWarning(error: unknown): void {
  if (loggedRedisError) return;
  loggedRedisError = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[print-ops-jobs] Redis unavailable; background jobs will retry when Redis returns: ${message}`);
}

function connection(kind: "queue" | "worker"): IORedis {
  const client = new IORedis(redisUrl(), {
    // Railway private hostnames may resolve to IPv4 or IPv6. Let ioredis use
    // either family and leave room for the private network to establish.
    family: 0,
    connectTimeout: 10_000,
    enableOfflineQueue: false,
    // BullMQ requires this for worker and blocking connections. Keeping it on
    // the producer too prevents a short retry limit from tearing down a job.
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 1_000, 30_000),
  });
  let connectedOnce = false;
  client.on("ready", () => {
    if (connectedOnce) {
      loggedRedisError = false;
      console.info(`[print-ops-jobs] Redis ${kind} connection re-established.`);
    }
    connectedOnce = true;
  });
  client.on("error", logRedisWarning);
  return client;
}

function queueJobId(name: PrintOpsJobName, key: string): string {
  return `${name}-${createHash("sha256").update(key).digest("hex")}`;
}

async function processJob(job: Job<PrintOpsJobData, unknown, PrintOpsJobName>): Promise<unknown> {
  if (job.name === "shipment-email") return runShipmentEmailJob(job.data as ShipmentEmailJob);
  if (job.name === "marketplace-ship-note") return runMarketplaceShipNoteJob(job.data as MarketplaceShipNoteJob);
  if (job.name === "sync-health") {
    const { runSyncHealthCheck } = await import("./sync-health");
    return runSyncHealthCheck();
  }
  throw new Error(`Unknown print-ops job ${job.name}`);
}

const SYNC_HEALTH_EVERY_MS = 15 * 60 * 1000;

/** Repeat the HubSpot sync check on the existing Redis worker. No-op without REDIS_URL. */
export async function scheduleSyncHealthJob(): Promise<void> {
  if (!redisUrl()) return;
  if (!queue) startPrintOpsJobWorker();
  if (!queue) throw new Error("Print Ops Redis queue did not initialize");
  await queue.add("sync-health", { kind: "sync-health" }, {
    repeat: { every: SYNC_HEALTH_EVERY_MS, key: "sync-health" },
  });
}

export function startPrintOpsJobWorker(): void {
  if (startupAttempted) return;
  startupAttempted = true;
  if (!redisUrl()) {
    console.info("[print-ops-jobs] REDIS_URL is unset; using synchronous job fallback.");
    return;
  }

  const queueConnection = connection("queue");
  queue = new Queue(QUEUE_NAME, { connection: queueConnection });
  worker = new Worker(QUEUE_NAME, processJob, { connection: connection("worker"), concurrency: 4 });
  worker.on("error", logRedisWarning);
  worker.on("failed", (job, error) => {
    console.warn(
      `[print-ops-jobs] ${job?.name ?? "job"} ${job?.id ?? "unknown"} failed (attempt ${job?.attemptsMade ?? 0}): ${error.message}`,
    );
  });
  worker.on("ready", () => {
    loggedRedisError = false;
    console.info("[print-ops-jobs] Redis worker ready.");
  });
}

export async function enqueueShipmentEmailJob(
  input: ShipmentEmailJob,
): Promise<{ queued: boolean; result?: BuyerEmailSend }> {
  if (!redisUrl()) return { queued: false, result: await runShipmentEmailJob(input) };
  if (!queue) startPrintOpsJobWorker();
  if (!queue) throw new Error("Print Ops Redis queue did not initialize");
  await queue.add("shipment-email", input, {
    ...RETRY_OPTIONS,
    jobId: queueJobId("shipment-email", `${input.dealId}:${input.trackingNumber}`),
  });
  return { queued: true };
}

export async function enqueueMarketplaceShipNoteJob(
  input: MarketplaceShipNoteJob,
): Promise<{ queued: boolean; result?: ReturnType<typeof runMarketplaceShipNoteJob> }> {
  if (!redisUrl()) return { queued: false, result: runMarketplaceShipNoteJob(input) };
  if (!queue) startPrintOpsJobWorker();
  if (!queue) throw new Error("Print Ops Redis queue did not initialize");
  await queue.add("marketplace-ship-note", input, {
    ...RETRY_OPTIONS,
    jobId: queueJobId("marketplace-ship-note", `${input.dealId}:${input.trackingNumber}`),
  });
  return { queued: true };
}

/** Test helper. It does not close Redis connections in production code. */
export async function resetPrintOpsJobWorkerForTest(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
  startupAttempted = false;
  loggedRedisError = false;
}
