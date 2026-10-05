import type { EntityManager } from 'typeorm';
import { inTransactionWithRetry, type IsolationLevel, type RetryInfo } from './common/transaction-retry.js';
import { dataSource } from './data-source.js';
import { UserEntity } from './entities/index.js';
import { RETRY_START_BALANCE_CENTS, RETRY_USER_EMAIL } from './seed-fixtures.js';

// Forces a 40001 and shows the retry wrapper recovering from it.
//
// ⚠️ DELIBERATELY WRONG PATTERN — do not "fix" into an atomic update. Both
// transactions read the balance into JavaScript, compute, and write back an
// absolute value. Checkout never does this (it updates atomically); here it's
// the point. Under READ COMMITTED it silently loses an update; under
// REPEATABLE READ the second writer gets 40001 instead, and the wrapper retries.
//
// The interleaving is forced with signals, not sleeps, so the conflict always
// happens:
//   B reads (its snapshot is taken here) → signals "read"
//   A waits for "read", then reads, writes, commits → signals "committed"
//   B waits for "committed", then writes → 40001 (A changed the row after B's snapshot)
//   B's retry: both signals already resolved, so it reads A's result and commits.
// DEMO_COMPARE=1 also runs the same pair under READ COMMITTED: no error, wrong balance.

const DEPOSIT_CENTS = 5_000n; // A: +50.00
const WITHDRAWAL_CENTS = 3_000n; // B: −30.00
const SIGNAL_TIMEOUT_MS = 5_000;
const RETRYABLE = new Set(['40001', '40P01']);

const userRepository = dataSource.getRepository(UserEntity);

// A promise resolved or rejected from outside — the signal between the two
// transactions. A no-op catch keeps an early rejection from being reported as
// unhandled; awaiting it later still rejects.
function signal() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

// If the other side fails, its signal never comes: fail loudly, never stall.
async function waitFor(promise: Promise<void>, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), SIGNAL_TIMEOUT_MS);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const readBalance = async (manager: EntityManager, userId: string) =>
  BigInt((await manager.findOneByOrFail(UserEntity, { id: userId })).balanceCents);

const writeBalance = (manager: EntityManager, userId: string, balanceCents: bigint) =>
  manager.update(UserEntity, { id: userId }, { balanceCents: balanceCents.toString() });

async function runScenario(userId: string, isolationLevel: IsolationLevel) {
  await userRepository.update({ id: userId }, { balanceCents: String(RETRY_START_BALANCE_CENTS) });

  const bHasRead = signal();
  const aHasCommitted = signal();
  const caught: (RetryInfo & { side: string })[] = [];

  // A: waits until B holds its snapshot, then deposits and commits. "Committed"
  // is signalled after inTransactionWithRetry returns — i.e. after COMMIT, from
  // outside the transaction. A failure rejects the signal, so B can't hang.
  const transactionA = (async () => {
    try {
      await waitFor(bHasRead.promise, "B's read");
      await inTransactionWithRetry(
        dataSource,
        isolationLevel,
        async (manager) => {
          const balance = await readBalance(manager, userId);
          await writeBalance(manager, userId, balance + DEPOSIT_CENTS);
        },
        { label: 'A', onRetry: (info) => caught.push({ ...info, side: 'A' }) },
      );
      aHasCommitted.resolve();
    } catch (error) {
      aHasCommitted.reject(error);
      throw error;
    }
  })();

  // B: reads first — before awaiting anything, or its snapshot would postdate
  // A's commit and there'd be no conflict — then waits for A, then writes.
  const transactionB = inTransactionWithRetry(
    dataSource,
    isolationLevel,
    async (manager) => {
      const balance = await readBalance(manager, userId);
      bHasRead.resolve();
      await waitFor(aHasCommitted.promise, "A's commit");
      await writeBalance(manager, userId, balance - WITHDRAWAL_CENTS);
    },
    { label: 'B', onRetry: (info) => caught.push({ ...info, side: 'B' }) },
  ).catch((error) => {
    bHasRead.reject(error);
    throw error;
  });

  const results = await Promise.allSettled([transactionA, transactionB]);
  for (const result of results) {
    if (result.status === 'rejected') console.error('  transaction failed:', result.reason);
  }
  const finalBalance = BigInt((await userRepository.findOneByOrFail({ id: userId })).balanceCents);
  return { results, caught, finalBalance };
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail: unknown) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`);
  if (!ok) failures.push(label);
}

await dataSource.initialize();
try {
  const { id: userId } = await userRepository.findOneByOrFail({ email: RETRY_USER_EMAIL });
  const expected = BigInt(RETRY_START_BALANCE_CENTS) + DEPOSIT_CENTS - WITHDRAWAL_CENTS;

  const { results, caught, finalBalance } = await runScenario(userId, 'REPEATABLE READ');

  // G4 — the brief's terms.
  console.log(`\nпійманих 40001/40P01: ${caught.length}`);
  console.log(`фінальний баланс: ${finalBalance} (очікувано ${expected})`);

  // G5
  console.log('\nChecks:');
  check('retries caught ≥ 1', caught.length >= 1, caught.map((info) => `${info.side}:${info.code}`).join(', ') || 'none');
  check('every caught code is 40001 or 40P01', caught.every((info) => RETRYABLE.has(info.code)), caught.map((info) => info.code).join(', ') || '—');
  check('final balance = start + 50.00 − 30.00', finalBalance === expected, `${finalBalance} = ${expected}`);
  check('A and B both fulfilled', results.every((result) => result.status === 'fulfilled'), results.map((result) => result.status).join(', '));

  // G6 — optional contrast: the same pair at READ COMMITTED. No error, and B's
  // absolute write overwrites A's deposit — the lost update.
  if (process.env.DEMO_COMPARE === '1') {
    const contrast = await runScenario(userId, 'READ COMMITTED');
    console.log(
      `\nбез REPEATABLE READ: фінальний баланс ${contrast.finalBalance} (очікувано ${expected}), ` +
        `пійманих 40001/40P01: ${contrast.caught.length}`,
    );
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
