import { QueryFailedError, type DataSource, type EntityManager } from 'typeorm';

// The levels this project uses — a local union rather than a deep import from
// TypeORM's internals, which a minor release could move.
export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

// Postgres asks for the whole transaction to be retried with exactly these:
// 40001 serialization_failure, 40P01 deadlock_detected. Anything else is a real
// error and is rethrown at once.
const RETRYABLE_CODES = new Set(['40001', '40P01']);

export interface RetryInfo {
  attempt: number; // the attempt that just failed, from 1
  code: string;
  delayMs: number;
}

export interface RetryOptions {
  // Printed in every retry log line, so concurrent retriers can be told apart.
  label?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  // Called once per retry, so a caller (the retry demo) can count them.
  onRetry?: (info: RetryInfo) => void;
}

// The pg error sits on the failed query's driverError. A failure that surfaces
// as a raw driver error instead — which path a failed COMMIT takes is
// unverified — carries the code on itself, so read that as a fallback.
function postgresErrorCode(error: unknown): string | undefined {
  const source = error instanceof QueryFailedError ? error.driverError : error;
  const { code } = (source ?? {}) as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs work in one transaction at the given isolation level, and re-runs the
// whole transaction — never just the failed statement — on 40001 or 40P01.
// Each retry waits a random time up to a doubling ceiling ("full jitter"), so
// transactions that collided don't collide again in lockstep.
export async function inTransactionWithRetry<T>(
  dataSource: DataSource,
  isolationLevel: IsolationLevel,
  work: (manager: EntityManager) => Promise<T>,
  { label = 'transaction', maxAttempts = 5, baseDelayMs = 20, onRetry }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await dataSource.transaction(isolationLevel, work);
    } catch (error) {
      const code = postgresErrorCode(error);
      if (!code || !RETRYABLE_CODES.has(code) || attempt >= maxAttempts) throw error;

      const delayMs = Math.random() * baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry:${label}] attempt ${attempt}/${maxAttempts} failed with ${code}; retrying in ${Math.round(delayMs)} ms`);
      onRetry?.({ attempt, code, delayMs });
      await sleep(delayMs);
    }
  }
}
