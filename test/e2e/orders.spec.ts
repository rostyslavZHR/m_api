import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Repository } from 'typeorm';
import { IdempotencyKeyEntity, JobEntity, OrderEntity, OutboxEntity, ProductEntity, UserEntity } from '../../src/entities/index.js';
import { ProductsRepository } from '../../src/products/products.repository.js';
import { createTestApp } from '../integration/testkit/app.js';
import { aProduct, aUser } from '../integration/testkit/builders.js';
import { startTestDatabase, type TestDatabase } from '../integration/testkit/postgres.js';
import { accessTokenFor, bearer } from '../integration/testkit/tokens.js';
import { startTestQueue, type TestRedis } from '../integration/testkit/redis.js';

describe('Orders API (e2e)', () => {
  let db: TestDatabase;
  let queue: TestRedis;
  let app: NestExpressApplication;
  let products: ProductsRepository;
  let users: Repository<UserEntity>;
  let customer: UserEntity;

  // Every request as a user: the order routes require an access token, and act for
  // its user (orders are placed for and read by their owner).
  const api = async (user: UserEntity = customer) =>
    request.agent(app.getHttpServer()).set('Authorization', bearer(await accessTokenFor({ id: user.id })));
  const orderBody = (product: ProductEntity, quantity: number) => ({
    items: [{ product_id: Number(product.id), quantity }],
  });

  beforeAll(async () => {
    // A real Redis for the token denylist: the guard fails closed, so with none
    // every protected route would answer 503.
    [db, queue] = await Promise.all([startTestDatabase(), startTestQueue()]);
    app = await createTestApp(db, { REDIS_QUEUE_URL: queue.url });
    products = new ProductsRepository(db.app.manager);
    users = db.app.getRepository(UserEntity);
  });

  beforeEach(async () => {
    // Each test starts with empty rate-limit counters (5 per 10 s on POST /orders) and
    // an empty denylist: the Redis is real now.
    await queue.cli('FLUSHALL');
    await db.reset();
    customer = await aUser().insertVia(users);
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.stop(), queue?.stop()]);
  });

  it('runs on the test container: exactly the products arranged there, as app_user', async () => {
    const product = await aProduct().insertVia(products);

    const { body } = await (await api()).get('/products').expect(200);
    expect(body).toEqual([expect.objectContaining({ id: Number(product.id) })]);
    expect((await (await api()).get('/db').expect(200)).body.current_user).toBe('app_user');
  });

  it('creates an order, then reads the same order back', async () => {
    const user = await aUser().withBalanceCents('10000').insertVia(users);
    const product = await aProduct().withStock(5).withPriceCents('1500').insertVia(products);
    const body = orderBody(product, 2);
    const as = await api(user);

    const created = await as.post('/orders').set('Idempotency-Key', randomUUID()).send(body).expect(201);
    expect(created.body).toMatchObject({ items: body.items, total_cents: 3000, status: 'paid' });

    const read = await as.get(`/orders/${created.body.id}`).expect(200);
    expect(read.body).toEqual(created.body);

    // Checked in the container itself, not through the API.
    expect(await db.admin.manager.count(OrderEntity)).toBe(1);
    expect(await db.admin.manager.count(JobEntity)).toBe(1);
    expect((await db.admin.manager.findOneByOrFail(ProductEntity, { id: product.id })).stock).toBe(3);
  });

  // Orders and their outbox rows, checked in the container itself.
  const counts = async () => ({
    orders: await db.admin.manager.count(OrderEntity),
    outbox: await db.admin.manager.count(OutboxEntity),
  });

  it('the same Idempotency-Key twice in a row: one order, one event, the same response', async () => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().insertVia(products);
    const key = randomUUID();
    const as = await api(user);

    const first = await as.post('/orders').set('Idempotency-Key', key).send(orderBody(product, 1)).expect(201);
    const second = await as.post('/orders').set('Idempotency-Key', key).send(orderBody(product, 1)).expect(201);

    expect(second.body).toEqual(first.body);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await counts()).toEqual({ orders: 1, outbox: 1 });
    expect(await db.admin.manager.findOneByOrFail(IdempotencyKeyEntity, { key })).toMatchObject({
      userId: user.id,
      orderId: String(first.body.id),
    });
  });

  it('the same Idempotency-Key twice at the same moment: one order, one event, both get it', async () => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().withStock(5).insertVia(products);
    const key = randomUUID();
    const as = await api(user);
    const send = () => as.post('/orders').set('Idempotency-Key', key).send(orderBody(product, 1));

    // The second request's key insert waits on the first one's until it commits.
    const [a, b] = await Promise.all([send(), send()]);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect([a.headers['idempotent-replayed'], b.headers['idempotent-replayed']].filter(Boolean)).toEqual(['true']);
    expect(await counts()).toEqual({ orders: 1, outbox: 1 });
    expect((await db.admin.manager.findOneByOrFail(ProductEntity, { id: product.id })).stock).toBe(4);
  });

  it('the same Idempotency-Key with a different body: 422, and no second order', async () => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().withStock(5).insertVia(products);
    const key = randomUUID();
    const as = await api(user);

    await as.post('/orders').set('Idempotency-Key', key).send(orderBody(product, 1)).expect(201);
    const misuse = await as.post('/orders').set('Idempotency-Key', key).send(orderBody(product, 2)).expect(422);

    expect(misuse.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(await counts()).toEqual({ orders: 1, outbox: 1 });
  });

  it('the same Idempotency-Key from two users: two orders, one each (keys are per user)', async () => {
    const alice = await aUser().insertVia(users);
    const bob = await aUser().insertVia(users);
    const product = await aProduct().withStock(5).insertVia(products);
    const key = randomUUID();

    const a = await (await api(alice)).post('/orders').set('Idempotency-Key', key).send(orderBody(product, 1)).expect(201);
    const b = await (await api(bob)).post('/orders').set('Idempotency-Key', key).send(orderBody(product, 1)).expect(201);

    expect(a.body.id).not.toBe(b.body.id);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(await counts()).toEqual({ orders: 2, outbox: 2 });
  });

  it('answers 404 with a problem body for an order that does not exist', async () => {
    const { body } = await (await api()).get('/orders/999').expect(404).expect('Content-Type', /application\/problem\+json/);
    expect(body).toMatchObject({ status: 404 });
  });

  it('answers 400 when the body breaks the spec (no items, quantity 0), and writes nothing', async () => {
    const product = await aProduct().insertVia(products);
    const as = await api();

    await as.post('/orders').set('Idempotency-Key', randomUUID()).send({}).expect(400);
    // quantity: 0 would reach checkout() as a RangeError, a 500: the spec's
    // minimum: 1 has to stop it first.
    await as.post('/orders').set('Idempotency-Key', randomUUID()).send(orderBody(product, 0)).expect(400);
    expect(await db.admin.manager.count(OrderEntity)).toBe(0);
  });

  it('answers 409 when stock is short, and leaves the stock as it was', async () => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().withStock(1).insertVia(products);

    await (await api(user)).post('/orders').set('Idempotency-Key', randomUUID()).send(orderBody(product, 2)).expect(409);
    expect(await db.admin.manager.count(OrderEntity)).toBe(0);
    expect((await db.admin.manager.findOneByOrFail(ProductEntity, { id: product.id })).stock).toBe(1);
  });
});
