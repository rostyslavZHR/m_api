// npm run demo:crash-relay — the relay dies by SIGKILL after the broker confirmed
// the event and before it marked the row published. A fresh relay publishes the
// same event again; the consumer gets it twice, applies it once and skips it once.
// At-least-once delivery, exactly one effect.
//
// published=1 deliveries=2 applied=1 effect=1 processed=1
//
// The kill: the relay's demo-only switch RELAY_CRASH_AFTER_CONFIRM=1 makes it
// SIGKILL itself between the confirms and the UPDATE: a real kill -9 at an exact
// point, no race.
import { checkout } from '../checkout/checkout.js';
import {
  checker,
  linesOf,
  log,
  prepare,
  printResults,
  runDemo,
  startConsumer,
  startRelay,
  waitUntil,
} from './lib.js';
import { countRun, createFixture, openAppDb, runLines } from './run.js';

await runDemo('demo:crash-relay', async (onCleanup) => {
  await prepare(onCleanup);
  const db = await openAppDb();
  onCleanup(() => db.destroy());
  const { userId, productId } = await createFixture(db);

  // The order first, with no relay running: its outbox row waits.
  const order = await checkout(db, { userId, items: [{ productId, quantity: 1 }] });
  const [eventId] = (await countRun(db, userId)).eventIds;
  log(`run user ${userId}: order ${order.id}, event ${eventId}`);

  const consumer = startConsumer();
  onCleanup(() => consumer.stop());
  if (!(await consumer.waitFor((lines) => linesOf(lines, 'ready').length > 0, 15_000))) {
    throw new Error('the consumer did not start (see its log above)');
  }

  // 1. The crashing relay: publishes, gets the confirm, dies before the UPDATE.
  const crashing = startRelay({ crashAfterConfirm: true });
  onCleanup(() => crashing.stop());
  const exit = await Promise.race([
    crashing.exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
  ]);
  if (!exit) log('the crashing relay was still running after 15 s');
  await crashing.stop();
  const afterCrash = await countRun(db, userId);
  log(`first relay exited ${JSON.stringify(exit)}; published after the crash: ${afterCrash.published}`);

  // 2. A normal relay: the row is still waiting, so it publishes the event again.
  const relay = startRelay();
  onCleanup(() => relay.stop());
  const done = await waitUntil(async () => {
    const counts = await countRun(db, userId);
    const seen = runLines(consumer.lines, [eventId]);
    return counts.published >= 1 && seen.applied + seen.skipped >= 2;
  }, 20_000);
  if (!done) log('the second delivery was not processed within 20 s');
  await relay.stop();
  await consumer.stop();

  const counts = await countRun(db, userId);
  const { deliveries, applied, skipped } = runLines(consumer.lines, [eventId]);
  printResults([
    ['published', counts.published],
    ['deliveries', deliveries],
    ['applied', applied],
    ['effect', counts.effect],
    ['processed', counts.processed],
  ]);

  const { check, passed } = checker();
  check('published=1', counts.published === 1);
  check(`deliveries=${deliveries} >= 2`, deliveries >= 2);
  check('applied=1', applied === 1);
  check('effect=1', counts.effect === 1);
  check('processed=1', counts.processed === 1);
  // Beyond the contract: it really was a crash in the window, and the second
  // delivery was recognised as a duplicate.
  check(`the first relay died by SIGKILL (${exit?.signal ?? 'still running'})`, exit?.signal === 'SIGKILL');
  check(`the row was still waiting after the crash (published=${afterCrash.published})`, afterCrash.published === 0);
  check(`skipped=${skipped} >= 1 (the duplicate)`, skipped >= 1);
  return passed();
});
