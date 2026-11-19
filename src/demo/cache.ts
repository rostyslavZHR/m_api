// npm run demo:cache — the product card behind cache-aside, in this process (the
// database-call counter only counts here, and HTTP would hit the rate limit):
//   the cache instance evicts (allkeys-lru, a maxmemory);
//   50 cards warmed for this run get spread-out TTLs (jitter);
//   one of them evicted for real, then 25 concurrent reads → 1 database call (the
//   single-flight lock); then 100 reads of the warm key → 0.
//
// cache-lru=1 cache-maxmemory=1 warmed=50 ttl-distinct=… concurrent=25 db-calls=1 db-calls-warm=0
//
// The key disappears by an honest eviction, not a DEL: cold keys are flooded into a
// namespace of this run (cold:<runId>:…, so a second run adds new memory instead of
// overwriting the first run's keys) until LRU has removed one of the warmed cards.
// Approximate LRU picks which one, so the demo takes whichever went first.
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { cardQueries, ProductsRepository } from '../products/products.repository.js';
import { cardKey, ProductsService } from '../products/products.service.js';
import { closeRedis, createCacheClient } from '../redis/redis-clients.js';
import { checker, connected, deleteMatching, log, migrate, printResults, requireEnv, runDemo } from './lib.js';
import { openAppDb } from './run.js';

const PRODUCTS = 50;
const CONCURRENT = 25;
const WARM_READS = 100;
// Cold keys: 1 KB each, written in batches, checked for an eviction after each one.
// 32 MB of cache fills within ~35 batches; 120 is the give-up point.
const COLD_VALUE = 'x'.repeat(1024);
const BATCH = 1_000;
const MAX_BATCHES = 120;
// Cold keys expire by themselves too, in case the cleanup below doesn't run.
const COLD_TTL_SECONDS = 120;

const configValue = async (redis: Redis, name: string) => ((await redis.config('GET', name)) as string[])[1];

await runDemo('demo:cache', async (onCleanup) => {
  await migrate(onCleanup);
  const db = await openAppDb();
  onCleanup(() => db.destroy());
  const cache = createCacheClient(requireEnv('REDIS_CACHE_URL'));
  onCleanup(() => closeRedis(cache));
  await connected(cache);
  const runId = randomUUID().slice(0, 8);
  const service = new ProductsService(new ProductsRepository(db.manager), cache);
  const dbCalls = async (fn: () => Promise<unknown>) => {
    const before = cardQueries.count;
    await fn();
    return cardQueries.count - before;
  };

  // The instance's policy, read over the cache connection itself.
  const policy = await configValue(cache, 'maxmemory-policy');
  const maxmemory = Number(await configValue(cache, 'maxmemory'));
  log(`cache: maxmemory-policy ${policy}, maxmemory ${maxmemory}`);

  // This run's products, deleted at the end (no order references them).
  const products = (await db.query(
    `INSERT INTO products (name, description, price_cents, stock)
     SELECT 'Demo cache ' || $1::text || ' #' || n, 'For the HW#23 cache demo', 1000 + n, 10
     FROM generate_series(1, $2::int) AS n
     RETURNING id`,
    [runId, PRODUCTS],
  )) as { id: string }[];
  const ids = products.map(({ id }) => Number(id));
  onCleanup(async () => {
    await cache.del(...ids.map(cardKey));
    await db.query('DELETE FROM products WHERE id = ANY($1::bigint[])', [ids]);
  });
  log(`run ${runId}: products ${ids[0]}…${ids[ids.length - 1]}`);

  // Warm every card once.
  let warmed = 0;
  for (const id of ids) {
    const { card } = await service.getCard(id);
    if (card.id === id) warmed++;
  }
  const ttls = (await cache.pipeline(ids.map((id) => ['ttl', cardKey(id)])).exec()) ?? [];
  const ttlDistinct = new Set(ttls.map(([, ttl]) => ttl)).size;

  // Flood cold keys until LRU evicts a warmed card. EXISTS doesn't count as an
  // access, so checking doesn't protect the cards from eviction.
  onCleanup(async () => {
    log(`cold keys removed: ${await deleteMatching(cache, `cold:${runId}:*`)}`);
  });
  let evicted: number | undefined;
  for (let batch = 0; batch < MAX_BATCHES && evicted === undefined; batch++) {
    const pipeline = cache.pipeline();
    for (let i = 0; i < BATCH; i++) {
      pipeline.set(`cold:${runId}:${batch * BATCH + i}`, COLD_VALUE, 'EX', COLD_TTL_SECONDS);
    }
    await pipeline.exec();
    const exists = (await cache.pipeline(ids.map((id) => ['exists', cardKey(id)])).exec()) ?? [];
    const index = exists.findIndex(([, found]) => found === 0);
    if (index >= 0) {
      evicted = ids[index];
      log(`after ${(batch + 1) * BATCH} cold keys, LRU evicted ${cardKey(evicted)}`);
    }
  }
  if (evicted === undefined) {
    throw new Error(`no warmed card evicted after ${MAX_BATCHES * BATCH} cold keys`);
  }

  // The stampede: many readers at once on the key that just disappeared.
  let concurrent = 0;
  const stampedeCalls = await dbCalls(async () => {
    const results = await Promise.all(Array.from({ length: CONCURRENT }, () => service.getCard(evicted)));
    concurrent = results.filter(({ card }) => card.id === evicted).length;
  });

  // The same key, warm again.
  const warmCalls = await dbCalls(async () => {
    for (let i = 0; i < WARM_READS; i++) await service.getCard(evicted);
  });

  printResults([
    ['cache-lru', policy !== 'noeviction' ? 1 : 0],
    ['cache-maxmemory', maxmemory > 0 ? 1 : 0],
    ['warmed', warmed],
    ['ttl-distinct', ttlDistinct],
    ['concurrent', concurrent],
    ['db-calls', stampedeCalls],
    ['db-calls-warm', warmCalls],
  ]);

  const { check, passed } = checker();
  check(`cache-lru: the policy evicts (${policy})`, policy !== 'noeviction');
  check(`cache-maxmemory > 0 (${maxmemory})`, maxmemory > 0);
  check(`warmed=${warmed} >= 50`, warmed >= 50);
  check(`ttl-distinct=${ttlDistinct} >= 5`, ttlDistinct >= 5);
  check(`concurrent=${concurrent} >= 20`, concurrent >= 20);
  check(`db-calls=${stampedeCalls}, expected 1`, stampedeCalls === 1);
  check(`db-calls-warm=${warmCalls}, expected 0`, warmCalls === 0);
  return passed();
});
