// npm run demo:duplicate — the consumer crashes (SIGKILL) after writing the invoice
// and before acking; the broker redelivers; a fresh consumer recognises the event
// and skips it. One event, at least two deliveries, one invoice.
//
// deliveries=… effect=1 skipped=…
import {
  checker,
  linesOf,
  log,
  printResults,
  requireEnv,
  resetBroker,
  runDemo,
  startConsumer,
} from './lib.js';
import { countInvoices, openShop } from './shop.js';

await runDemo('demo:duplicate', async (onCleanup) => {
  const broker = await resetBroker(requireEnv('RABBITMQ_URL'));
  onCleanup(() => broker.connection.close());
  const shop = await openShop();
  onCleanup(() => shop.close());

  const {
    eventIds: [eventId],
    published,
  } = await shop.placeOrders(1);
  if (published !== 1) throw new Error(`eventId=${eventId} was not published`);

  // 1. The crashing consumer: applies the effect, then kills itself before the ack.
  const crashing = startConsumer({ crashAfterEffect: true });
  const exit = await Promise.race([
    crashing.exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
  if (!exit) {
    log('the crashing consumer was still running after 10 s; stopping it');
    await crashing.stop();
  }
  const effectAfterCrash = await countInvoices(shop.dataSource, [eventId]);
  log(`first consumer exited: ${JSON.stringify(exit)}; invoices so far: ${effectAfterCrash}`);

  // 2. A normal consumer gets the unacked message again. Any outcome ends the
  // wait; a rejected duplicate is a failure the checks below report.
  const second = startConsumer();
  const settled = await second.waitFor(
    (lines) =>
      [
        ...linesOf(lines, 'applied'),
        ...linesOf(lines, 'skipped'),
        ...linesOf(lines, 'rejected'),
      ].some((line) => line.messageId === eventId),
    10_000,
  );
  if (!settled) log(`eventId=${eventId} was not redelivered within 10 s`);
  await second.stop();

  const lines = [...crashing.lines, ...second.lines];
  const deliveries = linesOf(lines, 'delivery').filter((l) => l.messageId === eventId);
  const skipped = linesOf(lines, 'skipped').filter((l) => l.messageId === eventId).length;
  const effect = await countInvoices(shop.dataSource, [eventId]);

  printResults([
    ['deliveries', deliveries.length],
    ['effect', effect],
    ['skipped', skipped],
  ]);

  const { check, passed } = checker();
  check(`deliveries=${deliveries.length}, expected at least 2`, deliveries.length >= 2);
  check(`effect=${effect}, expected 1`, effect === 1);
  // Beyond the contract: the setup really was a crash after the effect, and the
  // redelivery was recognised as a duplicate rather than failing or applying again.
  check(`first consumer died by SIGKILL (${exit?.signal ?? 'still running'})`, exit?.signal === 'SIGKILL');
  check(`effect committed before the crash (${effectAfterCrash})`, effectAfterCrash === 1);
  check(
    `a redelivery arrived (redelivered=true)`,
    deliveries.slice(1).some((line) => line.redelivered),
  );
  check(`skipped=${skipped}, expected at least 1`, skipped >= 1);
  return passed();
});
