import type { DataSource, EntityManager } from 'typeorm';
import { JobEntity } from '../entities/index.js';

export interface WorkerOptions {
  // Simulated work per job, done while the claiming transaction is still open.
  jobDurationMs: number;
  // How long to wait when new jobs exist but every one is locked by another worker.
  pollDelayMs: number;
  // A bug in the "anything left?" check must not spin forever.
  deadline: number; // epoch ms
  // false runs the same loop without SKIP LOCKED — workers queue on one row.
  skipLocked?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Claims the first new job by id. FOR UPDATE takes the row lock; SKIP LOCKED
// passes over rows another worker holds instead of waiting on them. limit(1)
// is essential: getOne() adds no LIMIT, so without it the query would lock
// every new job and one worker would take the whole queue.
// setLock throws outside a transaction — a useful guard.
function claimNextJob(manager: EntityManager, skipLocked: boolean): Promise<JobEntity | null> {
  const query = manager
    .createQueryBuilder(JobEntity, 'job')
    .where('job.status = :status', { status: 'new' })
    .orderBy('job.id', 'ASC')
    .limit(1)
    .setLock('pessimistic_write');
  if (skipLocked) query.setOnLocked('skip_locked');
  return query.getOne();
}

// The result and the status commit together. processed is incremented in SQL,
// so the row itself records how many times the work was really applied.
async function completeJob(manager: EntityManager, jobId: string, workerName: string): Promise<void> {
  await manager
    .createQueryBuilder()
    .update(JobEntity)
    .set({ status: 'done', worker: workerName, processed: () => 'processed + 1' })
    .where('id = :jobId', { jobId })
    .execute();
}

// One job: claim, work, complete — all in one transaction. The work happens
// with the transaction open, so a worker that dies mid-job rolls back, its lock
// disappears, and the job is new again for someone else.
async function processOneJob(
  dataSource: DataSource,
  workerName: string,
  { jobDurationMs, skipLocked = true }: WorkerOptions,
): Promise<boolean> {
  return dataSource.transaction(async (manager) => {
    const job = await claimNextJob(manager, skipLocked);
    if (!job) return false;

    await sleep(jobDurationMs);
    await completeJob(manager, job.id, workerName);
    return true;
  });
}

// Runs until the queue is empty and returns how many jobs this worker did.
// Nothing claimed means one of two things: no new jobs at all (stop), or new
// jobs that are all locked by other workers right now (wait, then try again).
export async function runWorker(dataSource: DataSource, workerName: string, options: WorkerOptions): Promise<number> {
  const jobRepository = dataSource.getRepository(JobEntity);
  let processedCount = 0;

  for (;;) {
    if (Date.now() > options.deadline) {
      throw new Error(`${workerName}: deadline passed with jobs still pending`);
    }

    if (await processOneJob(dataSource, workerName, options)) {
      processedCount++;
      continue;
    }

    const remaining = await jobRepository.countBy({ status: 'new' });
    if (remaining === 0) return processedCount;
    await sleep(options.pollDelayMs);
  }
}
