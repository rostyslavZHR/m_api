// The outbox relay's logic: a polling relay (#153) that moves committed outbox rows
// to RabbitMQ. The process around it is src/relay/main.ts; the publisher is passed
// in, so the tests run it with a fake.
import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSource } from 'typeorm';
import type { OutboxMessage } from '../messaging/order-placed.publisher.js';

// What the relay needs from a publisher (OrderPlacedPublisher in production).
export interface Publisher {
  // Throws if the broker can't be reached.
  connect(): Promise<void>;
  // true once the broker confirmed this message; false (or a throw) otherwise.
  publish(message: OutboxMessage): Promise<boolean>;
}

export interface RelayOptions {
  // Rows per batch. Small, because their row locks are held while publishing.
  batchSize: number;
  // A row whose publish failed this many times is parked: skipped and logged.
  maxAttempts: number;
  // Sleep between polls when there's nothing (or less than a batch) to send.
  pollMs: number;
}

export const DEFAULTS: RelayOptions = {
  batchSize: 50,
  maxAttempts: 10,
  pollMs: 500,
};

export interface BatchResult {
  selected: number;
  published: string[];
  failed: string[];
  // Failed rows that have now reached maxAttempts.
  parked: string[];
}

interface Row {
  id: string;
  type: string;
  payload: object;
  created_at: Date;
}

// One batch, in one transaction on one connection (dataSource.transaction holds a
// single pooled connection from BEGIN to COMMIT, so the SELECT … FOR UPDATE and the
// UPDATEs share it):
//   1. take up to batchSize waiting rows, oldest first, locking them; SKIP LOCKED
//      skips rows another relay holds, so two relays never take the same row (#134);
//   2. publish each, waiting for its own broker confirm (bounded by the publisher's
//      timeout);
//   3. mark the confirmed ones published, add an attempt to the failed ones;
//   4. commit both together.
// Nothing throws on a failed publish, so the attempts increment is committed rather
// than rolled back. A row is marked only after its confirm: marking first would lose
// the event whenever the broker then dropped it.
export async function relayBatch(
  dataSource: DataSource,
  publisher: Publisher,
  { batchSize, maxAttempts }: Pick<RelayOptions, 'batchSize' | 'maxAttempts'>,
): Promise<BatchResult> {
  return dataSource.transaction(async (manager) => {
    // The partial index's exact condition (published_at IS NULL) and order: an
    // index scan. attempts < $1 leaves parked rows out.
    const rows: Row[] = await manager.query(
      `SELECT id, type, payload, created_at FROM outbox
       WHERE published_at IS NULL AND attempts < $1
       ORDER BY created_at, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [maxAttempts, batchSize],
    );
    if (rows.length === 0) {
      return { selected: 0, published: [], failed: [], parked: [] };
    }

    // All at once on the confirm channel, in selection order; each waits for its
    // own confirm. A throw counts as a failure too.
    const confirmed = await Promise.all(
      rows.map((row) =>
        publisher
          .publish({
            id: row.id,
            type: row.type,
            payload: row.payload,
            createdAt: row.created_at,
          })
          .catch(() => false),
      ),
    );
    const published = rows.filter((_, i) => confirmed[i]).map((row) => row.id);
    const failed = rows.filter((_, i) => !confirmed[i]).map((row) => row.id);

    if (published.length > 0) {
      await manager.query(
        'UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])',
        [published],
      );
    }
    let parked: string[] = [];
    if (failed.length > 0) {
      // TypeORM returns [rows, rowCount] for an UPDATE … RETURNING.
      const [bumped] = (await manager.query(
        'UPDATE outbox SET attempts = attempts + 1 WHERE id = ANY($1::uuid[]) RETURNING id, attempts',
        [failed],
      )) as [{ id: string; attempts: number }[], number];
      parked = bumped
        .filter((row) => row.attempts >= maxAttempts)
        .map((row) => row.id);
    }
    return { selected: rows.length, published, failed, parked };
  });
}

export interface Backlog {
  // Waiting rows the relay will still try.
  pending: number;
  // Age of the oldest pending row, in seconds (0 if none).
  oldestSec: number;
  // Rows at maxAttempts: never published, needing a person.
  parked: number;
}

// The backlog signal (replaces HW#19's /health counter): how much is waiting, and
// how long the oldest has waited. A growing pending count or age means the relay
// isn't keeping up or can't reach the broker.
export async function readBacklog(
  dataSource: DataSource,
  maxAttempts: number,
): Promise<Backlog> {
  const [row] = (await dataSource.query(
    `SELECT count(*) FILTER (WHERE attempts < $1)::int AS pending,
            coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE attempts < $1)), 0)::int AS "oldestSec",
            count(*) FILTER (WHERE attempts >= $1)::int AS parked
     FROM outbox WHERE published_at IS NULL`,
    [maxAttempts],
  )) as Backlog[];
  return row;
}

// Exponential backoff with jitter, capped (#156): 0.5 s doubling to 30 s, each
// wait between half and all of that, so several relays recovering from the same
// outage don't retry in lockstep.
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
export const backoffWithJitter = (failures: number): number => {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
};

const BACKLOG_EVERY_MS = 10_000;

// The loop. Pacing: a full batch → go again at once (there's more); a partial or
// empty one → sleep pollMs; any failure (broker unreachable, a publish not
// confirmed, the DB) → back off with jitter. It never spins. Stops when `signal`
// aborts, after the batch in progress: an abort only cuts the sleeps short.
export async function runRelay(
  dataSource: DataSource,
  publisher: Publisher,
  {
    signal,
    log,
    options = DEFAULTS,
  }: {
    signal: AbortSignal;
    log: (message: string) => void;
    options?: RelayOptions;
  },
): Promise<void> {
  const pause = (ms: number) =>
    sleep(ms, undefined, { signal }).catch(() => undefined);
  let failures = 0;
  let lastBacklog = 0;

  const backOff = async (reason: string) => {
    failures++;
    const delay = backoffWithJitter(failures);
    log(`${reason}; retrying in ${delay} ms (failure ${failures})`);
    await pause(delay);
  };

  while (!signal.aborted) {
    if (Date.now() - lastBacklog >= BACKLOG_EVERY_MS) {
      lastBacklog = Date.now();
      try {
        const { pending, oldestSec, parked } = await readBacklog(
          dataSource,
          options.maxAttempts,
        );
        log(`backlog: pending=${pending} oldest=${oldestSec}s parked=${parked}`);
        if (parked > 0) {
          log(`PARKED: ${parked} outbox row(s) failed ${options.maxAttempts} times and are skipped; they need a person`);
        }
      } catch (error) {
        log(`backlog query failed: ${(error as Error).message}`);
      }
    }

    // A circuit-breaker-like check (#157): with the broker unreachable, don't take
    // row locks or spend attempts; wait and try again.
    try {
      await publisher.connect();
    } catch (error) {
      await backOff(`broker unreachable (${(error as Error).message})`);
      continue;
    }

    let result: BatchResult;
    try {
      result = await relayBatch(dataSource, publisher, options);
    } catch (error) {
      await backOff(`batch failed (${(error as Error).message})`);
      continue;
    }

    if (result.published.length > 0) {
      log(`published ${result.published.length} of ${result.selected}`);
    }
    for (const id of result.parked) {
      log(`PARKED: outbox row ${id} failed ${options.maxAttempts} times; skipped from now on`);
    }
    if (result.failed.length > 0) {
      await backOff(`${result.failed.length} of ${result.selected} not confirmed`);
      continue;
    }

    failures = 0;
    if (result.selected < options.batchSize) await pause(options.pollMs);
  }
}
