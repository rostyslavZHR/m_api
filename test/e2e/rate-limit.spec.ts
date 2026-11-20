// The rate limit through the HTTP API: two app instances on one Redis (configured
// like redis-queue) share one limit of 5 per 10 s, per route and per client.
// Every request here comes from 127.0.0.1, so "the client" is the IP unless a
// session cookie names a user.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Repository } from 'typeorm';
import { ProductEntity, UserEntity } from '../../src/entities/index.js';
import { ProductsRepository } from '../../src/products/products.repository.js';
import { RATE_LIMIT } from '../../src/rate-limit/rate-limiter.js';
import { createTestApp } from '../integration/testkit/app.js';
import { aProduct, aUser } from '../integration/testkit/builders.js';
import { startTestDatabase, type TestDatabase } from '../integration/testkit/postgres.js';
import { startTestQueue, type TestRedis } from '../integration/testkit/redis.js';
import { accessTokenFor, bearer } from '../integration/testkit/tokens.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const { limit } = RATE_LIMIT;

describe('Rate limit (e2e)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: NestExpressApplication;
  let secondApp: NestExpressApplication;
  let users: Repository<UserEntity>;
  let product: ProductEntity;

  const card = (on = app, cookie?: string) => {
    const req = request(on.getHttpServer()).get(`/products/${product.id}/card`);
    return cookie ? req.set('Cookie', cookie) : req;
  };

  // A user with a session; returns the "sid=…" pair for the Cookie header.
  const loggedInUser = async () => {
    const user = await aUser().withBalanceCents('100000').insertVia(users);
    const response = await request(app.getHttpServer()).post('/sessions').send({ user_id: Number(user.id) }).expect(201);
    return { user, cookie: String(response.headers['set-cookie']).split(';')[0] };
  };

  const rateLimitKeys = async () => (await redis.cli('--scan', '--pattern', 'rl:*')).split('\n').filter(Boolean);

  beforeAll(async () => {
    [db, redis] = await Promise.all([startTestDatabase(), startTestQueue()]);
    app = await createTestApp(db, { REDIS_QUEUE_URL: redis.url });
    secondApp = await createTestApp(db, { REDIS_QUEUE_URL: redis.url });
    // Listening once: on a server that isn't listening, supertest opens a new
    // ephemeral listener per request, and 50 at once reset connections.
    await Promise.all([app.listen(0), secondApp.listen(0)]);
    users = db.app.getRepository(UserEntity);
  });

  beforeEach(async () => {
    await db.reset();
    await redis.cli('FLUSHALL');
    product = await aProduct().withStock(100).withPriceCents('100').insertVia(new ProductsRepository(db.app.manager));
  });

  afterAll(async () => {
    await Promise.all([app?.close(), secondApp?.close()]);
    await Promise.all([db?.stop(), redis?.stop()]);
  });

  it('two instances share one limit: exactly `limit` pass, then 429 with Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < limit; i++) {
      statuses.push((await card(i % 2 === 0 ? app : secondApp)).status);
    }
    const refused = await card(secondApp);

    expect(statuses).toEqual(Array(limit).fill(200));
    expect(refused.status).toBe(429);
    expect(refused.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(refused.body).toMatchObject({ type: 'https://example.com/problems/too-many-requests', status: 429 });
    const retryAfter = Number(refused.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(RATE_LIMIT.windowMs / 1000);
  });

  it('after Retry-After seconds a request passes again', async () => {
    for (let i = 0; i < limit; i++) await card().expect(200);
    const refused = await card().expect(429);

    await sleep(Number(refused.headers['retry-after']) * 1000);

    await card(secondApp).expect(200);
  }, 20_000);

  it('a concurrent burst of 50 over both instances: exactly `limit` pass', async () => {
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => card(i % 2 === 0 ? app : secondApp)));
    const statuses = responses.map((response) => response.status);

    expect(statuses.filter((status) => status === 200)).toHaveLength(limit);
    expect(statuses.filter((status) => status === 429)).toHaveLength(50 - limit);
  });

  it('different clients have independent limits: the IP, and each session user', async () => {
    const alice = await loggedInUser();
    const bob = await loggedInUser();

    for (let i = 0; i < limit; i++) await card().expect(200);
    await card().expect(429);

    for (const { cookie } of [alice, bob]) {
      for (let i = 0; i < limit; i++) await card(secondApp, cookie).expect(200);
      await card(app, cookie).expect(429);
    }
  });

  it('POST /orders has its own counter, with the same limit', async () => {
    const { user, cookie } = await loggedInUser();
    const token = await accessTokenFor({ id: user.id });
    const order = () =>
      request(app.getHttpServer())
        .post('/orders')
        .set('Cookie', cookie)
        .set('Authorization', bearer(token))
        .set('Idempotency-Key', randomUUID())
        .send({ user_id: Number(user.id), items: [{ product_id: Number(product.id), quantity: 1 }] });

    for (let i = 0; i < limit; i++) await card(app, cookie).expect(200);
    for (let i = 0; i < limit; i++) await order().expect(201);
    const refused = await order().expect(429);

    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(await rateLimitKeys()).toHaveLength(2);
  });

  it('an idle client leaves nothing behind: every key expires within the window', async () => {
    for (let i = 0; i < 3; i++) await card().expect(200);

    const keys = await rateLimitKeys();
    expect(keys).toEqual([expect.stringMatching(/^rl:ProductsController\.card:ip:/)]);
    const pttl = Number(await redis.cli('PTTL', keys[0]));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(RATE_LIMIT.windowMs);
  });

  it('Redis not answering → fail open: requests pass, nothing is limited', async () => {
    for (let i = 0; i < limit; i++) await card().expect(200);
    await card().expect(429);

    // Every client blocks for 3 s: each check times out (200 ms) and is let through.
    await redis.cli('CLIENT', 'PAUSE', '3000', 'ALL');
    for (let i = 0; i < limit; i++) await card().expect(200);
  });
});
