// The BullMQ jobs queue on a real Redis configured like redis-queue (noeviction,
// AOF) and a real Postgres, with the app's own queue, worker client, job options and
// handlers. Shorter backoff delays here, so retries take milliseconds.
import { type Job, type Queue, Worker } from 'bullmq';
import type { Repository } from 'typeorm';
import { UserEntity } from '../../src/entities/index.js';
import { cleanup, sendInvoiceEmail } from '../../src/jobs/handlers.js';
import {
  addInvoiceEmail,
  CLEANUP,
  CLEANUP_SCHEDULER_ID,
  createJobsQueue,
  JOB_OPTIONS,
  JOBS_QUEUE,
  upsertCleanupScheduler,
} from '../../src/jobs/jobs.js';
import { OrdersRepository } from '../../src/orders/orders.repository.js';
import { ProductsRepository } from '../../src/products/products.repository.js';
import { closeRedis, createQueueClient, createWorkerClient } from '../../src/redis/redis-clients.js';
import type { Redis } from 'ioredis';
import { aProduct, aUser, anOrder } from './testkit/builders.js';
import { startTestDatabase, type TestDatabase } from './testkit/postgres.js';
import { startTestQueue, type TestRedis } from './testkit/redis.js';

const FAST_RETRIES = { ...JOB_OPTIONS, backoff: { type: 'exponential', delay: 50, jitter: 0.5 } };

describe('Jobs queue (BullMQ)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let producer: Redis;
  let queue: Queue;
  const workers: Worker[] = [];
  const connections: Redis[] = [];

  // A worker with its own blocking connection, closed after each test.
  const startWorker = (handle: (job: Job) => Promise<unknown>) => {
    const connection = createWorkerClient(redis.url);
    const worker = new Worker(JOBS_QUEUE, handle, { connection });
    connections.push(connection);
    workers.push(worker);
    return worker;
  };

  const anOrderId = async () => {
    const user = await aUser().insertVia(db.app.getRepository(UserEntity) as Repository<UserEntity>);
    const product = await aProduct().insertVia(new ProductsRepository(db.app.manager));
    return Number((await anOrder(user, product).insertVia(new OrdersRepository(db.app.manager))).id);
  };

  beforeAll(async () => {
    [db, redis] = await Promise.all([startTestDatabase(), startTestQueue()]);
    producer = createQueueClient(redis.url);
    await new Promise((resolve) => producer.once('ready', resolve));
    queue = createJobsQueue(producer, FAST_RETRIES);
  });

  beforeEach(async () => {
    await db.reset();
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
    await Promise.all(connections.splice(0).map(closeRedis));
  });

  afterAll(async () => {
    await queue?.close();
    if (producer) await closeRedis(producer);
    await Promise.all([db?.stop(), redis?.stop()]);
  });

  it('a job that fails twice is retried with backoff, then completes on the 3rd attempt', async () => {
    const attempts: number[] = [];
    const worker = startWorker(async (job) => {
      attempts.push(Date.now());
      if (job.attemptsMade < 2) throw new Error(`failing attempt ${job.attemptsMade + 1}`);
      return 'ok';
    });
    const completed = new Promise<Job>((resolve) => worker.on('completed', resolve));

    await queue.add('flaky', {}, { jobId: 'flaky-1' });
    const job = await completed;

    expect(job.attemptsMade).toBe(3);
    expect(await job.getState()).toBe('completed');
    // The waits grow: base 50 then 100 ms, each shortened by at most half (jitter).
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(25);
    expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(50);
  });

  it('the same job id twice is one job, also after the first completed', async () => {
    await addInvoiceEmail(queue, 7);
    await addInvoiceEmail(queue, 7);

    expect(await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')).toEqual({
      waiting: 1,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    });

    let runs = 0;
    const worker = startWorker(async () => {
      runs++;
    });
    await new Promise((resolve) => worker.on('completed', resolve));
    await addInvoiceEmail(queue, 7);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(runs).toBe(1);
    expect(await queue.getJobCounts('waiting', 'completed')).toEqual({ waiting: 0, completed: 1 });
  });

  it('the scheduler upserted twice is one scheduler, and it fires repeatedly', async () => {
    await upsertCleanupScheduler(queue, 1_000);
    await upsertCleanupScheduler(queue, 1_000);

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((scheduler) => scheduler.key)).toEqual([CLEANUP_SCHEDULER_ID]);

    let runs = 0;
    startWorker(async (job) => {
      if (job.name === CLEANUP) {
        runs++;
        return cleanup(db.app);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 3_500));

    expect(runs).toBeGreaterThanOrEqual(2);
  });

  it('an invoice email processed twice is sent once', async () => {
    const orderId = await anOrderId();

    expect(await sendInvoiceEmail(db.app, orderId)).toBe('sent');
    expect(await sendInvoiceEmail(db.app, orderId)).toBe('already sent');

    const [{ count }] = (await db.app.query('SELECT count(*)::int AS count FROM invoice_emails WHERE order_id = $1', [
      orderId,
    ])) as { count: number }[];
    expect(count).toBe(1);
  });
});
