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

type PrintOpsJobName = "shipment-email" | "marketplace-ship-note";
type PrintOpsJobData = ShipmentEmailJob | MarketplaceShipNoteJob;

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

function connection(forWorker = false): IORedis {
  const client = new IORedis(redisUrl(), {
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: forWorker ? null : 1,
    retryStrategy: (times: number) => Math.min(times * 1_000, 30_000),
  });
  client.on("error", logRedisWarning);
  return client;
}

function queueJobId(name: PrintOpsJobName, key: string): string {
  return `${name}-${createHash("sha256").update(key).digest("hex")}`;
}

async function processJob(job: Job<PrintOpsJobData, unknown, PrintOpsJobName>): Promise<unknown> {
  if (job.name === "shipment-email") return runShipmentEmailJob(job.data as ShipmentEmailJob);
  return runMarketplaceShipNoteJob(job.data as MarketplaceShipNoteJob);
}

export function startPrintOpsJobWorker(): void {
  if (startupAttempted) return;
  startupAttempted = true;
  if (!redisUrl()) {
    console.info("[print-ops-jobs] REDIS_URL is unset; using synchronous job fallback.");
    return;
  }

  const queueConnection = connection();
  queue = new Queue(QUEUE_NAME, { connection: queueConnection });
  worker = new Worker(QUEUE_NAME, processJob, { connection: connection(true), concurrency: 4 });
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
