// npm run demo:dlq — one poison message (order.placed version 2, which this
// consumer doesn't know) → rejected without requeue → parked in the DLQ with
// x-first-death-reason, no invoice written.
//
// rejected=… work=0 dlq=1 dlq-reason=rejected effect=0
import {
  DEAD_LETTER_QUEUE,
  EVENTS_EXCHANGE,
  INVOICING_QUEUE,
  ORDER_PLACED_KEY,
} from '../messaging/topology.js';
import {
  type Broker,
  checker,
  linesOf,
  log,
  printResults,
  requireEnv,
  resetBroker,
  runDemo,
  settledDepth,
  startConsumer,
  waitForDepth,
} from './lib.js';
import { countInvoices, openShop } from './shop.js';

// The reasons RabbitMQ gives a dead letter.
const DEATH_REASONS = ['rejected', 'expired', 'maxlen', 'delivery_limit'];

// Reads the DLQ's head without taking it away: get it unacked, read the headers,
// put it back. nack, not reject: on a quorum queue only reject counts toward the
// delivery limit (20 by default for a queue without a policy, like the DLQ), and
// past it a queue with no DLX drops the message. Nothing here can loop, the DLQ
// has no DLX.
async function peekDeathReason(broker: Broker): Promise<string> {
  const message = await broker.channel.get(DEAD_LETTER_QUEUE, { noAck: false });
  if (!message) return 'none';
  const reason = message.properties.headers?.['x-first-death-reason'];
  log(
    `DLQ head: messageId=${message.properties.messageId}, x-death=${JSON.stringify(message.properties.headers?.['x-death'])}`,
  );
  broker.channel.nack(message, false, true);
  return typeof reason === 'string' ? reason : 'none';
}

await runDemo('demo:dlq', async (onCleanup) => {
  const broker = await resetBroker(requireEnv('RABBITMQ_URL'));
  onCleanup(() => broker.connection.close());
  const shop = await openShop();
  onCleanup(() => shop.close());

  const consumer = startConsumer();
  if (!(await consumer.waitFor((lines) => linesOf(lines, 'ready').length > 0, 10_000))) {
    throw new Error('the consumer did not start (see its log above)');
  }

  // A fresh id per run (no order_events row has one this large), so the effect
  // check below counts only this message. Otherwise a valid v1 body: only the
  // version makes it poison.
  const eventId = String(Date.now());
  const poison = {
    eventId,
    type: 'order.placed',
    version: 2,
    occurredAt: new Date().toISOString(),
    data: {
      orderId: 1,
      userId: 1,
      totalCents: '1000',
      items: [{ productId: 1, quantity: 1, unitPriceCents: '1000' }],
    },
  };
  await new Promise<void>((resolve, reject) =>
    broker.channel.publish(
      EVENTS_EXCHANGE,
      ORDER_PLACED_KEY,
      Buffer.from(JSON.stringify(poison)),
      {
        persistent: true,
        mandatory: true,
        messageId: eventId,
        type: 'order.placed',
        contentType: 'application/json',
      },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  log(`published poison eventId=${eventId} (version 2)`);

  const handled = await consumer.waitFor(
    (lines) => linesOf(lines, 'rejected').some((line) => line.messageId === eventId),
    10_000,
  );
  if (!handled) log('the consumer did not reject the poison message within 10 s');
  await consumer.stop();

  // At-least-once dead-lettering moves it to the DLQ asynchronously.
  if (!(await waitForDepth(broker.channel, DEAD_LETTER_QUEUE, 1))) {
    log('nothing arrived in the DLQ within 10 s');
  }
  const reason = await peekDeathReason(broker);
  // Measured after the peek, so the printed depth is what the DLQ holds at the end.
  const work = await settledDepth(broker.channel, INVOICING_QUEUE);
  const dlq = await settledDepth(broker.channel, DEAD_LETTER_QUEUE);
  const effect = await countInvoices(shop.dataSource, [eventId]);
  const rejected = linesOf(consumer.lines, 'rejected');

  printResults([
    ['rejected', rejected.length],
    ['work', work],
    ['dlq', dlq],
    ['dlq-reason', reason],
    ['effect', effect],
  ]);

  const { check, passed } = checker();
  check(`work=${work}, expected 0`, work === 0);
  check(`dlq=${dlq}, expected 1`, dlq === 1);
  check(`dlq-reason=${reason}, expected one of ${DEATH_REASONS.join('/')}`, DEATH_REASONS.includes(reason));
  check(`effect=${effect}, expected 0`, effect === 0);
  // Beyond the contract: poison goes to the DLQ at once, not after retries.
  check(
    `rejected=${rejected.length}, all without requeue`,
    rejected.length >= 1 && rejected.every((line) => !line.requeue),
  );
  return passed();
});
