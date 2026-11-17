import { z } from 'zod';
import type { OrderEntity } from '../entities/index.js';

// The order.placed contract, version 2. Every field is chosen here on purpose,
// never a spread of an ORM entity, so a new column can't leak into the message and
// consumers don't depend on the table layout.
//
// v2 vs v1: eventId is now the outbox row's uuid (v1: the order's creation row id,
// digits). Nothing else changed. Renaming a field later would be another breaking
// change, so the names stay v1's.
//
// One shape, two schemas:
//   - orderPlacedSchema (strict): what the producer may send. An unplanned field
//     is an error, so nothing leaks out by accident.
//   - orderPlacedReader (tolerant): what a consumer parses with. Unknown fields are
//     stripped, not rejected: when the producer adds an optional field to v2 (a
//     backward-compatible change), old consumers keep working instead of sending
//     every message to the DLQ. Only an unknown type or version, or a missing or
//     invalid required field, is poison. A v1 message is poison too: dev drains the
//     queue instead of reading both versions (see the README).

// Integer minor units as a decimal string: the columns are bigint, which a JSON
// number can't carry exactly past 2^53. Never a float. No currency field: the
// shop has one currency, and the HTTP API has none either.
const cents = z.string().regex(/^\d+$/);
const id = z.number().int().positive();

const itemShape = {
  productId: id,
  quantity: z.number().int().positive(),
  unitPriceCents: cents,
};

const dataShape = {
  orderId: id,
  userId: id,
  totalCents: cents,
};

const envelopeShape = {
  // The outbox row's id: generated before the insert, written in the order's
  // transaction, so every publish of this event (relay retries included) carries
  // the same value. What consumers deduplicate by.
  eventId: z.uuid(),
  // The same string as the routing key and the outbox row's type.
  type: z.literal('order.placed'),
  version: z.literal(2),
  // When the order was placed: the order row's created_at, not the publish time,
  // so two publishes of one eventId carry the same body.
  occurredAt: z.iso.datetime(),
};

export const orderPlacedSchema = z.strictObject({
  ...envelopeShape,
  data: z.strictObject({
    ...dataShape,
    items: z.array(z.strictObject(itemShape)).min(1),
  }),
});

// z.object strips unknown keys (zod's default), at every level.
export const orderPlacedReader = z.object({
  ...envelopeShape,
  data: z.object({
    ...dataShape,
    items: z.array(z.object(itemShape)).min(1),
  }),
});

export type OrderPlacedEvent = z.infer<typeof orderPlacedSchema>;

// Pure. `order` is the order as saved inside the checkout transaction, so the ids,
// the total and the prices are what was actually charged, not the request's input.
// Built there, after the insert, and written to the outbox in the same commit.
export const toOrderPlacedEvent = (
  order: OrderEntity,
  eventId: string,
): OrderPlacedEvent => ({
  eventId,
  type: 'order.placed',
  version: 2,
  occurredAt: order.createdAt.toISOString(),
  data: {
    orderId: Number(order.id),
    userId: Number(order.user.id),
    totalCents: String(order.totalCents),
    items: order.items
      .map((item) => ({
        productId: Number(item.productId),
        quantity: item.quantity,
        unitPriceCents: String(item.unitPriceCents),
      }))
      .sort((a, b) => a.productId - b.productId),
  },
});
