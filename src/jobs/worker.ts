// npm run worker: the BullMQ worker, a separate process like the relay and the
// consumer, so jobs run outside HTTP requests and the worker can be stopped,
// killed or scaled on its own.
import 'reflect-metadata';
import { type Job, Worker } from 'bullmq';
import { validateWorkerEnv } from '../config/env.schema.js';
import { storageConfigOf } from '../config/storage.js';
import { createS3Client } from '../storage/s3-client.js';
import { FilesRepository } from '../uploads/files.repository.js';
import { createAppDataSource } from '../db/app-data-source.js';
import { closeRedis, createWorkerClient } from '../redis/redis-clients.js';
import { cleanup, sendInvoiceEmail } from './handlers.js';
import { CLEANUP, INVOICE_EMAIL, type InvoiceEmailData, JOBS_QUEUE } from './jobs.js';

// The pid tells two workers' logs apart.
const log = (message: string) => console.error(`[worker ${process.pid}] ${message}`);

// Jobs mostly wait (the fake provider's 2 s): a few at a time keeps the DB pool small.
const CONCURRENCY = 5;

async function main(): Promise<void> {
  const env = validateWorkerEnv(process.env);
  const dataSource = await createAppDataSource(env.DB_URL, { poolSize: CONCURRENCY }).initialize();
  const connection = createWorkerClient(env.REDIS_QUEUE_URL);
  // The abandoned-upload cleanup deletes objects in the store.
  const storage = storageConfigOf(env);
  const s3 = createS3Client(storage);
  const uploads = { files: new FilesRepository(dataSource.manager), s3, bucket: storage.bucket, log };

  // A thrown Error fails the attempt, and BullMQ retries it with the job's backoff.
  const handle = async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case INVOICE_EMAIL: {
        const { orderId } = job.data as InvoiceEmailData;
        const outcome = await sendInvoiceEmail(dataSource, orderId);
        log(`${job.id}: ${outcome} (attempt ${job.attemptsMade + 1})`);
        return outcome;
      }
      case CLEANUP: {
        const deleted = await cleanup(dataSource, uploads);
        log(`${job.id}: cleanup ${JSON.stringify(deleted)}`);
        return deleted;
      }
      default:
        throw new Error(`unknown job name: ${job.name}`);
    }
  };

  const worker = new Worker(JOBS_QUEUE, handle, { connection, concurrency: CONCURRENCY });
  worker.on('failed', (job, error) => {
    const attempts = job?.opts.attempts ?? 1;
    const final = job && job.attemptsMade >= attempts ? ' (no attempts left: kept as failed)' : ', will retry';
    log(`${job?.id ?? '?'} failed, attempt ${job?.attemptsMade ?? '?'}/${attempts}${final}: ${error.message}`);
  });
  worker.on('stalled', (jobId) => log(`${jobId} stalled (its worker died or lost the lock): it runs again`));
  worker.on('error', (error) => log(`worker error: ${error.message}`));
  log(`processing "${JOBS_QUEUE}", concurrency ${CONCURRENCY}`);

  // Graceful stop: no new jobs; the ones in progress finish, then everything closes.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: finishing the jobs in progress`);
    await worker.close();
    await closeRedis(connection);
    s3.destroy();
    await dataSource.destroy();
    log('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

try {
  await main();
} catch (error) {
  log(`startup failed: ${(error as Error).message}`);
  process.exit(1);
}
