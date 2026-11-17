// The product card behind cache-aside, on a real Postgres and a real Redis (both
// Testcontainers). The database-call count comes from the repository itself.
import type { Repository } from 'typeorm';
import { UserEntity } from '../../src/entities/index.js';
import { OrdersRepository } from '../../src/orders/orders.repository.js';
import { cardQueries, ProductsRepository } from '../../src/products/products.repository.js';
import { CARD_TTL, cardKey, ProductsService } from '../../src/products/products.service.js';
import { closeRedis, createCacheClient } from '../../src/redis/redis-clients.js';
import { aProduct, aUser, anOrder } from './testkit/builders.js';
import { startTestDatabase, type TestDatabase } from './testkit/postgres.js';
import { startTestCache, type TestCache } from './testkit/redis.js';

describe('Product card cache (cache-aside)', () => {
  let db: TestDatabase;
  let cache: TestCache;
  let products: ProductsRepository;
  let orders: OrdersRepository;
  let users: Repository<UserEntity>;
  let service: ProductsService;

  // Database calls made by fn, counted where the SQL runs.
  const dbCalls = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const before = cardQueries.count;
    const result = await fn();
    return [result, cardQueries.count - before];
  };

  beforeAll(async () => {
    [db, cache] = await Promise.all([startTestDatabase(), startTestCache()]);
    products = new ProductsRepository(db.app.manager);
    orders = new OrdersRepository(db.app.manager);
    users = db.app.getRepository(UserEntity);
    service = new ProductsService(products, cache.client);
  });

  beforeEach(async () => {
    await db.reset();
    await cache.cli('FLUSHALL');
  });

  afterAll(async () => {
    await Promise.all([db?.stop(), cache?.stop()]);
  });

  it('computes the aggregates, leaving cancelled orders out', async () => {
    const user = await aUser().insertVia(users);
    const shoes = await aProduct().withStock(7).withPriceCents('1000').insertVia(products);
    const socks = await aProduct().withPriceCents('200').insertVia(products);
    await orders.insert({
      userId: user.id,
      status: 'paid',
      totalCents: '2200',
      items: [
        { productId: shoes.id, quantity: 2, unitPriceCents: '1000', productName: shoes.name },
        { productId: socks.id, quantity: 1, unitPriceCents: '200', productName: socks.name },
      ],
    });
    await orders.insert({ ...anOrder(user, shoes).withQuantity(5).build(), status: 'cancelled' });

    const card = await products.findCard(shoes.id);

    expect(card).toMatchObject({
      id: Number(shoes.id),
      price_cents: 1000,
      stock: 7,
      in_stock: true,
      sales: { units_sold: 2, orders: 1, buyers: 1, revenue_cents: 2000, units_sold_30d: 2 },
      bought_together: [{ product_id: Number(socks.id), title: socks.name, orders: 1 }],
    });
    expect(typeof card?.sales.last_ordered_at).toBe('string');
  });

  it('a miss reads the database once, a hit not at all, with identical responses', async () => {
    const product = await aProduct().insertVia(products);
    const user = await aUser().insertVia(users);
    await anOrder(user, product).insertVia(orders);

    const [miss, missCalls] = await dbCalls(() => service.getCard(Number(product.id)));
    const [hit, hitCalls] = await dbCalls(() => service.getCard(Number(product.id)));

    expect([miss.hit, missCalls]).toEqual([false, 1]);
    expect([hit.hit, hitCalls]).toEqual([true, 0]);
    expect(hit.card).toStrictEqual(miss.card);
  });

  it('stores the card with a TTL in [base, base + jitter]', async () => {
    const product = await aProduct().insertVia(products);

    await service.getCard(Number(product.id));
    const ttl = Number(await cache.cli('TTL', cardKey(Number(product.id))));

    expect(ttl).toBeGreaterThanOrEqual(CARD_TTL.baseSeconds - 1);
    expect(ttl).toBeLessThanOrEqual(CARD_TTL.baseSeconds + CARD_TTL.jitterSeconds);
  });

  it('spreads the TTLs of keys warmed together', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) ids.push(Number((await aProduct().insertVia(products)).id));

    for (const id of ids) await service.getCard(id);
    const ttls = await Promise.all(ids.map(async (id) => Number(await cache.cli('TTL', cardKey(id)))));

    expect(new Set(ttls).size).toBeGreaterThanOrEqual(5);
  });

  it('does not cache a missing product', async () => {
    await expect(service.getCard(999_999)).rejects.toThrow('Product 999999 not found.');
    expect(await cache.cli('EXISTS', cardKey(999_999))).toBe('0');
  });

  it('Redis unreachable: the card still comes back, from the database every time', async () => {
    const product = await aProduct().insertVia(products);
    const dead = createCacheClient('redis://127.0.0.1:1');
    const offline = new ProductsService(products, dead);
    try {
      const [first, firstCalls] = await dbCalls(() => offline.getCard(Number(product.id)));
      const [second, secondCalls] = await dbCalls(() => offline.getCard(Number(product.id)));

      expect(first.card.id).toBe(Number(product.id));
      expect([first.hit, firstCalls, second.hit, secondCalls]).toEqual([false, 1, false, 1]);
    } finally {
      await closeRedis(dead);
    }
  });

  it('a full cache that refuses writes (noeviction, OOM) does not fail the read', async () => {
    const product = await aProduct().insertVia(products);
    await cache.cli('CONFIG', 'SET', 'maxmemory-policy', 'noeviction');
    await cache.cli('CONFIG', 'SET', 'maxmemory', '1');
    try {
      const { card, hit } = await service.getCard(Number(product.id));

      expect([card.id, hit]).toEqual([Number(product.id), false]);
      expect(await cache.cli('EXISTS', cardKey(Number(product.id)))).toBe('0');
    } finally {
      await cache.cli('CONFIG', 'SET', 'maxmemory', '32mb');
      await cache.cli('CONFIG', 'SET', 'maxmemory-policy', 'allkeys-lru');
    }
  });
});
