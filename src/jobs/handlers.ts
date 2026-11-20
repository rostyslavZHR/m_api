// What the jobs do. BullMQ is at-least-once: a stalled job (its worker died, or
// held the lock too long) runs again, and a duplicate event can add the same order
// twice outside the dedup window. So each handler must be safe to run twice.
import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSource } from 'typeorm';
import { runAllCleanups } from '../maintenance/cleanup.js';

// The fake email provider's latency: long enough that a worker can be killed in
// the middle of a send.
export const SEND_DELAY_MS = 2_000;

// Sending is faked; the row is the effect, and its primary key (order_id) is the
// idempotency key, the way a real provider deduplicates by an idempotency key sent
// with the request. The "call" comes first and the row after it: a worker killed
// mid-call leaves no row, so the rerun sends; a rerun after the row is a no-op.
export async function sendInvoiceEmail(dataSource: DataSource, orderId: number): Promise<'sent' | 'already sent'> {
  await sleep(SEND_DELAY_MS);
  const inserted: unknown[] = await dataSource.query(
    `INSERT INTO invoice_emails (order_id) VALUES ($1)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING order_id`,
    [orderId],
  );
  return inserted.length === 1 ? 'sent' : 'already sent';
}

// Deletes by age only, so running it twice deletes nothing the second time.
export const cleanup = (dataSource: DataSource) => runAllCleanups(dataSource);
