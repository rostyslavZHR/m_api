// The jobs queue, shared by every process that touches it: the consumer adds the
// invoice emails, the app upserts the cleanup scheduler, the worker
// (src/jobs/worker.ts) runs both. BullMQ is at-least-once, so every handler is
// idempotent (src/jobs/handlers.ts).
import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

export const JOBS_QUEUE = 'jobs';

export const INVOICE_EMAIL = 'invoice-email';
export const CLEANUP = 'cleanup';

export interface InvoiceEmailData {
  orderId: number;
}

const DAY_SECONDS = 24 * 60 * 60;

export const JOB_OPTIONS = {
  // 5 attempts, waiting about 1, 2, 4, 8 s between them: 2^(attempt − 1) × delay,
  // each wait shortened by up to half (jitter), so retries after a shared outage
  // don't all come back in the same second.
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000, jitter: 0.5 },
  // Completed jobs are kept 7 days, and that is the deduplication window: a job id
  // only counts as a duplicate while its job still exists. removeOnComplete: true
  // would delete it at once and let the same id run again.
  removeOnComplete: { age: 7 * DAY_SECONDS },
  // Failed jobs (all attempts used) are kept 30 days to be looked at and retried;
  // the worker logs each failure as it happens.
  removeOnFail: { age: 30 * DAY_SECONDS },
} satisfies JobsOptions;

// The business key, with a prefix: BullMQ refuses ids made only of digits, and ':'
// would clash with its own key separator.
export const invoiceEmailJobId = (orderId: number) => `${INVOICE_EMAIL}-${orderId}`;

// connection: a createQueueClient() client (fails fast). BullMQ uses it as is and
// doesn't close it: its owner does.
export function createJobsQueue(connection: Redis, defaultJobOptions: JobsOptions = JOB_OPTIONS): Queue {
  const queue = new Queue(JOBS_QUEUE, { connection, defaultJobOptions });
  // Without a listener an 'error' event would be unhandled.
  queue.on('error', (error) => console.error(`[jobs] queue error: ${error.message}`));
  return queue;
}

// Adding the same order twice is one job (while the first is kept): the outbox's
// at-least-once delivery may hand the consumer the same event again.
export const addInvoiceEmail = (queue: Queue, orderId: number) =>
  queue.add(INVOICE_EMAIL, { orderId } satisfies InvoiceEmailData, { jobId: invoiceEmailJobId(orderId) });

// One scheduler, under a fixed id: upsert creates it the first time and updates it
// after that, so every app start keeps exactly one. Daily at 03:00; everyMs (the
// demo's, CLEANUP_EVERY_MS) replaces the pattern with a short interval.
export const CLEANUP_SCHEDULER_ID = 'cleanup-daily';
export const CLEANUP_PATTERN = '0 3 * * *';

export const upsertCleanupScheduler = (queue: Queue, everyMs?: number) =>
  queue.upsertJobScheduler(CLEANUP_SCHEDULER_ID, everyMs ? { every: everyMs } : { pattern: CLEANUP_PATTERN }, {
    name: CLEANUP,
    data: {},
    // Cleanup is idempotent and runs again at the next tick: no long retries, and
    // a short history is enough.
    opts: { attempts: 3, backoff: { type: 'exponential', delay: 1_000, jitter: 0.5 }, removeOnComplete: { count: 100 }, removeOnFail: { age: 7 * DAY_SECONDS } },
  });
