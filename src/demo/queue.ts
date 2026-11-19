// npm run demo:queue — BullMQ on the queue instance, on a queue of this run's own
// (jobs-demo-<runId>, obliterated at the end), with a worker in this process: a dev
// worker on the real "jobs" queue can't take the demo's jobs, and the real
// cleanup scheduler is never touched.
//   the instance doesn't evict (noeviction);
//   a job failing twice → 3 attempts (fast backoff), then completed;
//   the same job id added twice → 1 job;
//   a scheduler every 1 s → at least 2 runs in 3.5 s.
//
// queue-noeviction=1 attempts=3 completed=1 added=2 queued=1 schedulers=1 scheduled-runs=3
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Job, Worker } from 'bullmq';
import { createJobsQueue, JOB_OPTIONS } from '../jobs/jobs.js';
import { closeRedis, createQueueClient, createWorkerClient } from '../redis/redis-clients.js';
import { checker, connected, log, printResults, requireEnv, runDemo, scanKeys } from './lib.js';

// The demo's retries: 100 ms base instead of 1 s.
const FAST_RETRIES = { ...JOB_OPTIONS, backoff: { type: 'exponential', delay: 100, jitter: 0.5 } };
const SCHEDULER_EVERY_MS = 1_000;
const OBSERVE_MS = 3_500;
const FLAKY_DEADLINE_MS = 10_000;

await runDemo('demo:queue', async (onCleanup) => {
  const url = requireEnv('REDIS_QUEUE_URL');
  const runId = randomUUID().slice(0, 8);
  const name = `jobs-demo-${runId}`;

  const producer = createQueueClient(url);
  onCleanup(() => closeRedis(producer));
  await connected(producer);
  const policy = ((await producer.config('GET', 'maxmemory-policy')) as string[])[1];
  log(`queue instance: maxmemory-policy ${policy}; queue ${name}`);

  const queue = createJobsQueue(producer, { name, defaultJobOptions: FAST_RETRIES });
  onCleanup(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    const left = await scanKeys(producer, `bull:${name}:*`);
    log(`queue ${name} obliterated, keys left: ${left.length}`);
  });

  // 1. Deduplication, before any worker runs: two adds, one id.
  const dedupId = `demo-${runId}`;
  let added = 0;
  for (let i = 0; i < 2; i++) {
    await queue.add('dedup', {}, { jobId: dedupId });
    added++;
  }
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'prioritized');
  const queued = Object.values(counts).reduce((sum, n) => sum + n, 0);

  // The worker: 'flaky' fails its first two attempts, 'tick' counts scheduler runs.
  let ticks = 0;
  const connection = createWorkerClient(url);
  onCleanup(() => closeRedis(connection));
  const worker = new Worker(
    name,
    async (job: Job) => {
      if (job.name === 'flaky' && job.attemptsMade < 2) throw new Error(`failing attempt ${job.attemptsMade + 1}`);
      if (job.name === 'tick') ticks++;
      return 'ok';
    },
    { connection },
  );
  worker.on('failed', (job, error) => log(`${job?.id} attempt ${job?.attemptsMade} failed: ${error.message}`));
  onCleanup(() => worker.close());

  // 2. Retries: fails twice, then completes.
  const flakyId = `flaky-${runId}`;
  const completedJob = new Promise<Job | undefined>((resolve) => {
    worker.on('completed', (job) => {
      if (job.id === flakyId) resolve(job);
    });
    setTimeout(() => resolve(undefined), FLAKY_DEADLINE_MS);
  });
  await queue.add('flaky', {}, { jobId: flakyId });
  const flaky = await completedJob;
  const attempts = flaky?.attemptsMade ?? (await queue.getJob(flakyId))?.attemptsMade ?? 0;
  const completed = flaky && (await flaky.getState()) === 'completed' ? 1 : 0;
  log(`${flakyId}: ${attempts} attempts, ${completed ? 'completed' : 'not completed'}`);

  // 3. A scheduler, upserted twice under one id: one scheduler, firing every second.
  for (let i = 0; i < 2; i++) {
    await queue.upsertJobScheduler('demo-tick', { every: SCHEDULER_EVERY_MS }, { name: 'tick' });
  }
  const schedulers = (await queue.getJobSchedulers()).length;
  await sleep(OBSERVE_MS);
  log(`scheduler runs in ${OBSERVE_MS} ms: ${ticks}`);

  printResults([
    ['queue-noeviction', policy === 'noeviction' ? 1 : 0],
    ['attempts', attempts],
    ['completed', completed],
    ['added', added],
    ['queued', queued],
    ['schedulers', schedulers],
    ['scheduled-runs', ticks],
  ]);

  const { check, passed } = checker();
  check(`queue-noeviction (${policy})`, policy === 'noeviction');
  check(`attempts=${attempts} >= 3`, attempts >= 3);
  check(`completed=${completed}, expected 1`, completed === 1);
  check(`added=${added}, expected 2`, added === 2);
  check(`queued=${queued}, expected 1`, queued === 1);
  check(`schedulers=${schedulers} >= 1`, schedulers >= 1);
  check(`scheduled-runs=${ticks} >= 2`, ticks >= 2);
  return passed();
});
