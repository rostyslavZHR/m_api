// npm run demo:outbox — two POST /orders with the same Idempotency-Key, through the
// real API (in this process, on a random port), the real relay and the real
// consumer (child processes): one order, one outbox row, published once, delivered
// once, one invoice, one processed_messages row.
//
// requests=2 orders=1 outbox=1 published=1 deliveries=1 effect=1 processed=1
import { randomUUID } from 'node:crypto';
import { startApi } from './api.js';
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

const REQUESTS = 2;

await runDemo('demo:outbox', async (onCleanup) => {
  await prepare(onCleanup);
  const db = await openAppDb();
  onCleanup(() => db.destroy());
  const { userId, productId, email, password } = await createFixture(db);
  log(`run user ${userId}, product ${productId}`);

  const consumer = startConsumer();
  onCleanup(() => consumer.stop());
  const relay = startRelay();
  onCleanup(() => relay.stop());
  if (!(await consumer.waitFor((lines) => linesOf(lines, 'ready').length > 0, 15_000))) {
    throw new Error('the consumer did not start (see its log above)');
  }

  // The API, in this process; POST /orders needs an access token, so log in first.
  const { url } = await startApi(onCleanup);
  const login = await fetch(`${url}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (login.status !== 200) throw new Error(`POST /auth/login answered ${login.status}`);
  const { accessToken } = (await login.json()) as { accessToken: string };

  // The same key twice, as a client retrying after a lost response would.
  const key = randomUUID();
  const responses: { status: number; id: unknown; replayed: string | null }[] = [];
  for (let i = 0; i < REQUESTS; i++) {
    const response = await fetch(`${url}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        user_id: Number(userId),
        items: [{ product_id: Number(productId), quantity: 1 }],
      }),
    });
    const body = (await response.json()) as { id?: unknown };
    responses.push({
      status: response.status,
      id: body.id,
      replayed: response.headers.get('idempotent-replayed'),
    });
  }
  log(`responses: ${JSON.stringify(responses)}`);

  // Until the consumer has handled this run's event and the relay has marked it.
  const done = await waitUntil(async () => {
    const counts = await countRun(db, userId);
    const seen = runLines(consumer.lines, counts.eventIds);
    return counts.published >= 1 && seen.applied + seen.skipped >= 1;
  }, 20_000);
  if (!done) log('the event was not published and processed within 20 s');
  // A moment for a duplicate delivery to show up, if there were one.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await relay.stop();
  await consumer.stop();

  const counts = await countRun(db, userId);
  const { deliveries } = runLines(consumer.lines, counts.eventIds);
  printResults([
    // Counted from the answers, not the loop's constant.
    ['requests', responses.length],
    ['orders', counts.orders],
    ['outbox', counts.outbox],
    ['published', counts.published],
    ['deliveries', deliveries],
    ['effect', counts.effect],
    ['processed', counts.processed],
  ]);

  const { check, passed } = checker();
  check(`requests=${responses.length}, expected ${REQUESTS}`, responses.length === REQUESTS);
  check('orders=1', counts.orders === 1);
  check('outbox=1', counts.outbox === 1);
  check('published=1', counts.published === 1);
  check('deliveries=1', deliveries === 1);
  check('effect=1', counts.effect === 1);
  check('processed=1', counts.processed === 1);
  // Beyond the contract: both answered 201 with the same order, the second as a replay.
  check(
    'both 201, the same order, the second replayed',
    responses.length === REQUESTS &&
      responses.every((r) => r.status === 201) &&
      responses[0].id === responses[1].id &&
      responses[0].replayed === null &&
      responses[1].replayed === 'true',
  );
  return passed();
});
