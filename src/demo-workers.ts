import { In, MoreThan } from 'typeorm';
import { dataSource } from './data-source.js';
import { JobEntity } from './entities/index.js';
import { runWorker } from './workers/job-worker.js';

// A pool of workers drains the job queue with SELECT … FOR UPDATE SKIP LOCKED.
// No job may be processed twice or left behind, and the pool must beat doing
// the jobs one by one. DEMO_COMPARE=1 also times the same batch without SKIP
// LOCKED, which is correct but no faster than a single worker.

const WORKER_COUNT = 4;
const MIN_BATCH = 20;
const JOB_DURATION_MS = 100;
const POLL_DELAY_MS = 20;
const DEADLINE_MS = 60_000;

const jobRepository = dataSource.getRepository(JobEntity);

const failures: string[] = [];
function check(label: string, ok: boolean, detail: unknown) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`);
  if (!ok) failures.push(label);
}

// F3 — top the queue up to MIN_BATCH (the race may not have run, so it could be
// empty), then snapshot the ids. Every check is about this run's jobs only; the
// race's send-receipt jobs, if pending, are drained like any other.
async function prepareBatch(): Promise<string[]> {
  const pending = await jobRepository.countBy({ status: 'new' });
  if (pending < MIN_BATCH) {
    await jobRepository.insert(Array.from({ length: MIN_BATCH - pending }, () => ({ type: 'demo' })));
  }
  const jobs = await jobRepository.find({ select: { id: true }, where: { status: 'new' }, order: { id: 'ASC' } });
  return jobs.map((job) => job.id);
}

// F4 — WORKER_COUNT workers started together, timed until the last one stops.
// allSettled, so a worker that throws is reported rather than abandoning the rest.
async function runPool(skipLocked: boolean) {
  const deadline = Date.now() + DEADLINE_MS;
  const startedAt = performance.now();
  const results = await Promise.allSettled(
    Array.from({ length: WORKER_COUNT }, (_, index) =>
      runWorker(dataSource, `w${index + 1}`, {
        jobDurationMs: JOB_DURATION_MS,
        pollDelayMs: POLL_DELAY_MS,
        deadline,
        skipLocked,
      }),
    ),
  );
  const elapsedMs = Math.round(performance.now() - startedAt);

  for (const result of results) {
    if (result.status === 'rejected') console.error('  worker failed:', result.reason);
  }
  const perWorker = results.map((result) => (result.status === 'fulfilled' ? result.value : 0));
  return { perWorker, elapsedMs, workerFailures: results.filter((result) => result.status === 'rejected').length };
}

await dataSource.initialize();
try {
  const jobIds = await prepareBatch();
  const sequentialMs = jobIds.length * JOB_DURATION_MS;

  const { perWorker, elapsedMs, workerFailures } = await runPool(true);

  const doubled = await jobRepository.countBy({ id: In(jobIds), processed: MoreThan(1) });
  const stillNew = await jobRepository.countBy({ id: In(jobIds), status: 'new' });
  const neverProcessed = await jobRepository.countBy({ id: In(jobIds), processed: 0 });

  // F5 — the brief's wording.
  console.log(`\n${perWorker.map((count, index) => `w${index + 1}=${count}`).join(' ')}`);
  console.log(`оброблено двічі: ${doubled}`);
  console.log(`час: ${elapsedMs} мс (послідовно: ${sequentialMs} мс)`);

  // F6
  console.log(`\nChecks (${jobIds.length} jobs):`);
  check('workers that processed at least one job ≥ 2', perWorker.filter((count) => count > 0).length >= 2, perWorker.filter((count) => count > 0).length);
  check('оброблено двічі = 0', doubled === 0, doubled);
  check('still new = 0', stillNew === 0, stillNew);
  check('processed = 0 → 0 jobs', neverProcessed === 0, neverProcessed);
  check('elapsed < sequential', elapsedMs < sequentialMs, `${elapsedMs} < ${sequentialMs}`);
  check('workers that failed = 0', workerFailures === 0, workerFailures);

  // F7 — optional: the same batch size without SKIP LOCKED.
  if (process.env.DEMO_COMPARE === '1') {
    const compareIds = await prepareBatch();
    const compare = await runPool(false);
    const compareDoubled = await jobRepository.countBy({ id: In(compareIds), processed: MoreThan(1) });
    console.log(`\nбез SKIP LOCKED: ${compare.perWorker.map((count, index) => `w${index + 1}=${count}`).join(' ')}`);
    console.log(`час: ${compare.elapsedMs} мс (послідовно: ${compareIds.length * JOB_DURATION_MS} мс), оброблено двічі: ${compareDoubled}`);
  }

  if (failures.length) {
    console.error(`\nFAILED: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll checks passed.');
  }
} finally {
  await dataSource.destroy();
}
