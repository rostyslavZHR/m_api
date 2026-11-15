// npm run demo:publish — 5 real orders → 5 order.placed events → the consumer
// writes 5 invoices, nothing dead-lettered.
//
// published=5 delivered=… effect=5 acked=… dlq=0 prefetch=…
import { DEAD_LETTER_QUEUE, INVOICING_QUEUE } from '../messaging/topology.js';
import {
  checker,
  linesOf,
  log,
  printResults,
  requireEnv,
  resetBroker,
  runDemo,
  settledDepth,
  startConsumer,
} from './lib.js';
import { countInvoices, openShop } from './shop.js';

const ORDERS = 5;

await runDemo('demo:publish', async (onCleanup) => {
  const broker = await resetBroker(requireEnv('RABBITMQ_URL'));
  onCleanup(() => broker.connection.close());
  const shop = await openShop();
  onCleanup(() => shop.close());

  // Orders first, consumer second: the 5 events wait in the queue, and the
  // consumer takes them in one burst under its prefetch.
  const { eventIds, published } = await shop.placeOrders(ORDERS);

  const consumer = startConsumer();
  if (!(await consumer.waitFor((lines) => linesOf(lines, 'ready').length > 0, 10_000))) {
    throw new Error('the consumer did not start (see its log above)');
  }
  const settled = await consumer.waitFor(
    (lines) =>
      linesOf(lines, 'applied').length + linesOf(lines, 'skipped').length >=
      published,
    10_000,
  );
  if (!settled) log('not every published event was acked within 10 s');
  // Stopped before measuring: a running consumer holds unacked messages, which
  // checkQueue doesn't count.
  await consumer.stop();

  const { lines } = consumer;
  const delivered = linesOf(lines, 'delivery').length;
  const acked =
    linesOf(lines, 'applied').length + linesOf(lines, 'skipped').length;
  const prefetch = linesOf(lines, 'ready')[0]?.prefetch ?? 0;
  const effect = await countInvoices(shop.dataSource, eventIds);
  const work = await settledDepth(broker.channel, INVOICING_QUEUE);
  const dlq = await settledDepth(broker.channel, DEAD_LETTER_QUEUE);

  printResults([
    ['published', published],
    ['delivered', delivered],
    ['effect', effect],
    ['acked', acked],
    ['dlq', dlq],
    ['prefetch', prefetch],
  ]);

  const { check, passed } = checker();
  check(`published=${published}, expected ${ORDERS}`, published === ORDERS);
  check(`effect=${effect}, expected ${ORDERS}`, effect === ORDERS);
  check(`dlq=${dlq}, expected 0`, dlq === 0);
  check(`prefetch=${prefetch}, expected 1..2000`, prefetch >= 1 && prefetch <= 2000);
  // Beyond the contract: anything else in the queue (a stale message, a
  // redelivery) shows up here instead of hiding behind the right effect count.
  check(`delivered=${delivered} and acked=${acked}, expected ${ORDERS} each`, delivered === ORDERS && acked === ORDERS);
  check(`work queue empty (${work})`, work === 0);
  return passed();
});
