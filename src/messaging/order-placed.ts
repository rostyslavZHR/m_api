import { z } from 'zod';
import type { OrderEventEntity } from '../entities/index.js';

// The order.placed contract, version 1. Every field is chosen here on purpose,
// never a spread of an ORM entity, so a new column can't leak into the message and
// consumers don't depend on the table layout.
//
// One shape, two schemas:
//   - orderPlacedSchema (strict): what the producer may send. An unplanned field
//     is an error, so nothing leaks out by accident.
//   - orderPlacedReader (tolerant): what a consumer parses with. Unknown fields are
//     stripped, not rejected: when the producer adds an optional field to v1 (a
//     backward-compatible change), old consumers keep working instead of sending
//     every message to the DLQ. Only an unknown type or version, or a missing or
//     invalid required field, is poison.

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
  // The order's creation event (order_events.id): written in the checkout
  // transaction, so it's the same on every publish attempt for this order.
  eventId: z.string().regex(/^\d+$/),
  type: z.literal('order.placed'),
  version: z.literal(1),
  // When the order was placed: the creation row's created_at, not the publish
  // time, so two publishes of one eventId carry the same body.
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

// Pure: the same committed rows always give the same event. Reads the creation
// event with its order, the order's items and its user loaded
// (OrdersRepository.findCreationEvent).
export const toOrderPlacedEvent = (
  creation: OrderEventEntity,
): OrderPlacedEvent => ({
  eventId: String(creation.id),
  type: 'order.placed',
  version: 1,
  occurredAt: creation.createdAt.toISOString(),
  data: {
    orderId: Number(creation.order.id),
    userId: Number(creation.order.user.id),
    totalCents: String(creation.order.totalCents),
    items: creation.order.items
      .map((item) => ({
        productId: Number(item.productId),
        quantity: item.quantity,
        unitPriceCents: String(item.unitPriceCents),
      }))
      .sort((a, b) => a.productId - b.productId),
  },
});
