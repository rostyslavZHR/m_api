import type { DataSource } from 'typeorm';
import type { OrderPlacedEvent } from '../messaging/order-placed.js';

export type InvoiceOutcome = 'applied' | 'skipped';

// The consumer's effect, idempotent by the event's id. One statement, so it commits
// on its own: either the row is new (applied) or an earlier delivery of the same
// event already wrote it (skipped). A redelivery after a crash between this commit
// and the ack lands on the second branch. Never "read, then insert if missing": two
// concurrent deliveries could both see nothing and both insert.
export async function insertInvoice(
  dataSource: DataSource,
  event: OrderPlacedEvent,
): Promise<InvoiceOutcome> {
  const rows: unknown[] = await dataSource.query(
    `INSERT INTO invoices (event_id, order_id, total_cents)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id`,
    [event.eventId, event.data.orderId, event.data.totalCents],
  );
  return rows.length === 1 ? 'applied' : 'skipped';
}
