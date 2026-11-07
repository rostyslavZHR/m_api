import type { Channel } from 'amqplib';

// Every RabbitMQ name in one place: the publisher, the consumer, the demos and the
// policy script (through the bootstrap) all take them from here.

// The domain exchange: topic, so keys go general → specific (<entity>.<event>) and a
// consumer can bind to one event or to a pattern such as order.*.
export const EVENTS_EXCHANGE = 'shop.events';
export const ORDER_PLACED_KEY = 'order.placed';

// The invoicing consumer's work queue, bound to ORDER_PLACED_KEY.
export const INVOICING_QUEUE = 'shop.invoicing';

// Dead letters: fanout, so everything that dies lands in one queue; x-death keeps the
// original routing key and queue.
export const DEAD_LETTER_EXCHANGE = 'shop.dlx';
export const DEAD_LETTER_QUEUE = 'shop.dlq';

// The alternate exchange for EVENTS_EXCHANGE: a message no binding matches lands
// here instead of being dropped with a positive confirm.
export const ALTERNATE_EXCHANGE = 'shop.ae';
export const UNROUTED_QUEUE = 'shop.unrouted';

// Returns per message before the broker dead-letters it (quorum queues only).
export const DELIVERY_LIMIT = 5;

// The only argument set in code: a queue's type is fixed at declaration anyway.
// Dead-lettering, the delivery limit and the alternate exchange come from policies
// (scripts/rabbitmq-policies.sh), which can change later; a changed argument here
// would fail with 406 PRECONDITION_FAILED.
const QUORUM = { 'x-queue-type': 'quorum' };

// Idempotent: assert* creates what's missing and leaves matching objects alone.
// Order matters: a binding needs both its exchange and its queue to exist.
export async function declareTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', {
    durable: true,
  });
  await channel.assertExchange(ALTERNATE_EXCHANGE, 'fanout', { durable: true });

  await channel.assertQueue(INVOICING_QUEUE, {
    durable: true,
    arguments: QUORUM,
  });
  // No dead-letter exchange of its own, so a dead letter can't loop.
  await channel.assertQueue(DEAD_LETTER_QUEUE, {
    durable: true,
    arguments: QUORUM,
  });
  await channel.assertQueue(UNROUTED_QUEUE, {
    durable: true,
    arguments: QUORUM,
  });

  await channel.bindQueue(INVOICING_QUEUE, EVENTS_EXCHANGE, ORDER_PLACED_KEY);
  await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');
  await channel.bindQueue(UNROUTED_QUEUE, ALTERNATE_EXCHANGE, '');
}
