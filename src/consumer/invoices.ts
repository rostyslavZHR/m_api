import type { DataSource } from 'typeorm';
import type { OrderPlacedEvent } from '../messaging/order-placed.js';

// This consumer's name in processed_messages: other consumers of the same event
// record their own rows.
export const CONSUMER = 'invoicing';

export type InvoiceOutcome =
  | { outcome: 'applied' }
  // This event was already processed (the inbox row exists): level 2.
  | { outcome: 'skipped'; reason: 'duplicate' }
  // A new event, but its order already has an invoice: level 1, the natural key.
  | { outcome: 'skipped'; reason: 'order already invoiced' };

// The consumer's effect, idempotent on two levels, in ONE transaction:
//   1. the inbox: INSERT INTO processed_messages … ON CONFLICT DO NOTHING RETURNING.
//      No row back = this consumer already processed this event → skip.
//   2. the effect: INSERT INTO invoices … ON CONFLICT (order_id) DO NOTHING, the
//      natural key (one invoice per order).
// Mark and effect commit together: separate transactions would be a dual write
// again (a crash between them = "processed, no invoice"). The caller acks only
// after this returns, i.e. after the commit. And the unique constraints are the
// check, never "SELECT, then insert if missing": two concurrent copies would both
// see nothing and both insert.
export async function insertInvoice(
  dataSource: DataSource,
  event: OrderPlacedEvent,
): Promise<InvoiceOutcome> {
  return dataSource.transaction(async (manager) => {
    const inbox: unknown[] = await manager.query(
      `INSERT INTO processed_messages (message_id, consumer)
       VALUES ($1, $2)
       ON CONFLICT (message_id, consumer) DO NOTHING
       RETURNING message_id`,
      [event.eventId, CONSUMER],
    );
    // Commits nothing new: the inbox row and its invoice are from an earlier
    // delivery.
    if (inbox.length === 0) return { outcome: 'skipped', reason: 'duplicate' };

    // ON CONFLICT names its target, so any other unique violation still raises
    // (and goes to the DLQ as an integrity error) instead of being swallowed.
    const invoice: unknown[] = await manager.query(
      `INSERT INTO invoices (order_id, total_cents)
       VALUES ($1, $2)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING id`,
      [event.data.orderId, event.data.totalCents],
    );
    // The inbox row still commits: this event is processed, there's just nothing
    // to do (its order was invoiced by another event).
    return invoice.length === 1
      ? { outcome: 'applied' }
      : { outcome: 'skipped', reason: 'order already invoiced' };
  });
}
