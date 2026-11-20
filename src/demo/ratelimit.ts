// npm run demo:ratelimit — two app instances in this process (two ports, each with
// its own limiter and its own Redis client), one shared limit: 2 × limit requests
// to the card, alternating between them. Exactly `limit` pass, the rest get 429
// with Retry-After. Two limiters that each counted alone would let all 2 × limit
// through with no 429: the request count is chosen to show exactly that.
//
// instances=2 limit=5 requests=10 allowed=5 blocked=5 status=429 retry-after=1
//
// Every run comes from 127.0.0.1, and a run within 10 s of the last one would
// start with its entries still in the window: the demo's own counter (this route,
// client ip:127.0.0.1) is deleted first, and again at the end. Other clients'
// counters are left alone.
import { randomUUID } from 'node:crypto';
import { cardKey } from '../products/products.service.js';
import { RATE_LIMIT } from '../rate-limit/rate-limiter.js';
import { closeRedis, createCacheClient, createRateLimitClient } from '../redis/redis-clients.js';
import { startApi } from './api.js';
import { checker, connected, log, migrate, printResults, requireEnv, runDemo } from './lib.js';
import { openAppDb } from './run.js';

const INSTANCES = 2;
const REQUESTS = 2 * RATE_LIMIT.limit;
// The guard's key, rl:<Controller.handler>:<client>, for this demo's requests: the
// apps listen on 127.0.0.1 and the demo calls them there.
const DEMO_KEY = 'rl:ProductsController.card:ip:127.0.0.1';

await runDemo('demo:ratelimit', async (onCleanup) => {
  await migrate(onCleanup);
  const db = await openAppDb();
  onCleanup(() => db.destroy());
  const counters = createRateLimitClient(requireEnv('REDIS_QUEUE_URL'));
  onCleanup(() => closeRedis(counters));
  const cache = createCacheClient(requireEnv('REDIS_CACHE_URL'));
  onCleanup(() => closeRedis(cache));
  await Promise.all([connected(counters), connected(cache)]);

  const [product] = (await db.query(
    `INSERT INTO products (name, description, price_cents, stock) VALUES ($1, 'For the HW#23 rate-limit demo', 1000, 10) RETURNING id`,
    [`Demo ratelimit ${randomUUID().slice(0, 8)}`],
  )) as { id: string }[];
  const productId = Number(product.id);
  onCleanup(async () => {
    await cache.del(cardKey(productId));
    await db.query('DELETE FROM products WHERE id = $1', [productId]);
  });

  log(`the demo's counter from an earlier run removed: ${await counters.del(DEMO_KEY)}`);
  onCleanup(async () => {
    await counters.del(DEMO_KEY);
  });

  const apis = [];
  for (let i = 0; i < INSTANCES; i++) apis.push(await startApi(onCleanup));
  log(`instances: ${apis.map(({ url }) => url).join(', ')}`);

  let allowed = 0;
  let blocked = 0;
  let lastRefused: number | undefined;
  let retryAfter: string | null = null;
  for (let i = 0; i < REQUESTS; i++) {
    const response = await fetch(`${apis[i % INSTANCES].url}/products/${productId}/card`);
    await response.arrayBuffer();
    log(`request ${i + 1} → instance ${(i % INSTANCES) + 1}: ${response.status}`);
    if (response.status === 200) allowed++;
    else {
      blocked++;
      lastRefused = response.status;
      retryAfter = response.headers.get('retry-after');
    }
  }
  log(`Retry-After on the last refusal: ${retryAfter}`);

  printResults([
    ['instances', apis.length],
    ['limit', RATE_LIMIT.limit],
    ['requests', REQUESTS],
    ['allowed', allowed],
    ['blocked', blocked],
    ['status', lastRefused ?? 0],
    ['retry-after', retryAfter !== null && Number(retryAfter) >= 1 ? 1 : 0],
  ]);

  const { check, passed } = checker();
  check(`instances=${apis.length}, expected 2`, apis.length === INSTANCES);
  check(`allowed=${allowed}, expected the limit ${RATE_LIMIT.limit}`, allowed === RATE_LIMIT.limit);
  check(`blocked=${blocked} >= 1`, blocked >= 1);
  check(`status=${lastRefused}, expected 429`, lastRefused === 429);
  check(`retry-after set (${retryAfter})`, retryAfter !== null && Number(retryAfter) >= 1);
  return passed();
});
