// The retention cleanups, shared by the npm scripts (cleanup-*.ts, run by hand or
// cron) and the scheduled BullMQ job (src/jobs). Each deletes by age only, so it's
// safe to run any time, any number of times.
import type { DataSource } from 'typeorm';

export interface Cleanup {
  name: string;
  retention: string;
  sql: string;
}

export const CLEANUPS = {
  // A retry after this creates a new order.
  idempotencyKeys: {
    name: 'idempotency keys',
    retention: '24 hours',
    sql: 'DELETE FROM idempotency_keys WHERE created_at < now() - $1::interval',
  },
  // Published rows only: waiting and parked rows (published_at IS NULL) stay.
  // Consumers dedupe by the event id in processed_messages, not by the outbox row.
  outbox: {
    name: 'published outbox rows',
    retention: '7 days',
    sql: 'DELETE FROM outbox WHERE published_at < now() - $1::interval',
  },
  // The inbox only has to outlive redeliveries; a later duplicate still meets the
  // natural key (invoices.order_id).
  processedMessages: {
    name: 'processed messages',
    retention: '30 days',
    sql: 'DELETE FROM processed_messages WHERE processed_at < now() - $1::interval',
  },
} satisfies Record<string, Cleanup>;

export async function runCleanup(dataSource: DataSource, { sql, retention }: Cleanup): Promise<number> {
  const [, deleted] = (await dataSource.query(sql, [retention])) as [unknown[], number];
  return deleted;
}

// All of them, in order; the count deleted by each.
export async function runAllCleanups(dataSource: DataSource): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const cleanup of Object.values(CLEANUPS)) {
    deleted[cleanup.name] = await runCleanup(dataSource, cleanup);
  }
  return deleted;
}
