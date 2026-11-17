// npm run demo:crash-write — placing an order (the API's path, with an
// Idempotency-Key) fails AFTER its outbox row was inserted, inside the
// transaction. With the relay and the consumer running for a few poll intervals,
// nothing comes out the other end: no order, no outbox row,
// nothing published, delivered or invoiced. The order and its event commit together
// or not at all.
//
// write-failed=1 orders=0 outbox=0 published=0 deliveries=0 effect=0
//
// The failure: a temporary trigger on the transaction's last statement, the
// UPDATE idempotency_keys (attachOrder) that runs after the order, its job and its
// outbox row were written. Not on the outbox insert itself: failing that statement
// would also fail an outbox insert that escaped the transaction, and the demo
// couldn't catch the Phase B trap. Created with the schema owner's credentials
// (app_user can't create triggers), limited by WHEN to this run's user, dropped in
// cleanup. No hook in the application code.
import { randomUUID } from 'node:crypto';
import { checkoutWithKey } from '../checkout/checkout.js';
import {
  checker,
  linesOf,
  log,
  prepare,
  printResults,
  runDemo,
  startConsumer,
  startRelay,
} from './lib.js';
import { countRun, createFixture, openAppDb, runLines } from './run.js';

// A few relay poll intervals (500 ms), so deliveries=0 means "nothing was there".
const WATCH_MS = 3_000;

await runDemo('demo:crash-write', async (onCleanup) => {
  const { admin } = await prepare(onCleanup);
  const db = await openAppDb();
  onCleanup(() => db.destroy());
  const { userId, productId } = await createFixture(db);
  log(`run user ${userId}, product ${productId}`);

  // userId is a number from our own INSERT … RETURNING, so it's safe in the DDL.
  const name = `demo_crash_write_${userId}`;
  await admin.query(`
    CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'demo:crash-write: failure after the outbox insert'; END $$;
    CREATE TRIGGER ${name} AFTER UPDATE ON idempotency_keys FOR EACH ROW
      WHEN (NEW.user_id = ${userId})
      EXECUTE FUNCTION ${name}();`);
  onCleanup(() =>
    admin.query(`DROP TRIGGER IF EXISTS ${name} ON idempotency_keys; DROP FUNCTION IF EXISTS ${name}();`),
  );

  const consumer = startConsumer();
  onCleanup(() => consumer.stop());
  const relay = startRelay();
  onCleanup(() => relay.stop());
  if (!(await consumer.waitFor((lines) => linesOf(lines, 'ready').length > 0, 15_000))) {
    throw new Error('the consumer did not start (see its log above)');
  }

  // The API's checkout transaction: the key, stock, balance, order, job, outbox
  // row… then the key's UPDATE fails, and the whole transaction rolls back.
  let writeFailed = 0;
  try {
    await checkoutWithKey(
      db,
      { userId, items: [{ productId, quantity: 1 }] },
      { key: randomUUID(), fingerprint: 'demo:crash-write' },
    );
    log('the order was placed: the failure did not happen');
  } catch (error) {
    writeFailed = 1;
    log(`placing the order failed: ${(error as Error).message}`);
  }

  await new Promise((resolve) => setTimeout(resolve, WATCH_MS));
  await relay.stop();
  await consumer.stop();

  const counts = await countRun(db, userId);
  const { deliveries } = runLines(consumer.lines, counts.eventIds);
  printResults([
    ['write-failed', writeFailed],
    ['orders', counts.orders],
    ['outbox', counts.outbox],
    ['published', counts.published],
    ['deliveries', deliveries],
    ['effect', counts.effect],
  ]);

  const { check, passed } = checker();
  check('write-failed=1', writeFailed === 1);
  check('orders=0', counts.orders === 0);
  check('outbox=0', counts.outbox === 0);
  check('published=0', counts.published === 0);
  check('deliveries=0', deliveries === 0);
  check('effect=0', counts.effect === 0);
  return passed();
});
