import { z } from 'zod';
import type { OrderEventEntity } from '../entities/index.js';

// The order.placed contract, version 1: the publisher builds it, the consumer
// (Phase E) validates incoming messages against the same schema. Every field is
// chosen here on purpose, never a spread of an ORM entity, so a new column can't
// leak into the message and consumers don't depend on the table layout.

// Integer minor units as a decimal string: the columns are bigint, which a JSON
// number can't carry exactly past 2^53. Never a float. No currency field: the
// shop has one currency, and the HTTP API has none either.
const cents = z.string().regex(/^\d+$/);
const id = z.number().int().positive();

export const orderPlacedSchema = z.strictObject({
  // The order's creation event (order_events.id): written in the checkout
  // transaction, so it's the same on every publish attempt for this order.
  eventId: z.string().regex(/^\d+$/),
  type: z.literal('order.placed'),
  version: z.literal(1),
  // When the order was placed: the creation row's created_at, not the publish
  // time, so two publishes of one eventId carry the same body.
  occurredAt: z.iso.datetime(),
  data: z.strictObject({
    orderId: id,
    userId: id,
    totalCents: cents,
    items: z
      .array(
        z.strictObject({
          productId: id,
          quantity: z.number().int().positive(),
          unitPriceCents: cents,
        }),
      )
      .min(1),
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
