import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Repository } from 'typeorm';
import { JobEntity, OrderEntity, ProductEntity, UserEntity } from '../../src/entities/index.js';
import { ProductsRepository } from '../../src/products/products.repository.js';
import { createTestApp } from '../integration/testkit/app.js';
import { aProduct, aUser } from '../integration/testkit/builders.js';
import { startTestDatabase, type TestDatabase } from '../integration/testkit/postgres.js';

describe('Orders API (e2e)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let products: ProductsRepository;
  let users: Repository<UserEntity>;

  const api = () => request(app.getHttpServer());
  const orderBody = (user: UserEntity, product: ProductEntity, quantity: number) => ({
    user_id: Number(user.id),
    items: [{ product_id: Number(product.id), quantity }],
  });

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp(db);
    products = new ProductsRepository(db.app.manager);
    users = db.app.getRepository(UserEntity);
  });

  beforeEach(async () => {
    await db.reset();
  });

  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  it('runs on the test container: exactly the products arranged there, as app_user', async () => {
    const product = await aProduct().insertVia(products);

    const { body } = await api().get('/products').expect(200);
    expect(body).toEqual([expect.objectContaining({ id: Number(product.id) })]);
    expect((await api().get('/db').expect(200)).body.current_user).toBe('app_user');
  });

  it('creates an order, then reads the same order back', async () => {
    const user = await aUser().withBalanceCents('10000').insertVia(users);
    const product = await aProduct().withStock(5).withPriceCents('1500').insertVia(products);
    const body = orderBody(user, product, 2);

    const created = await api().post('/orders').set('Idempotency-Key', randomUUID()).send(body).expect(201);
    expect(created.body).toMatchObject({ items: body.items, total_cents: 3000, status: 'paid' });

    const read = await api().get(`/orders/${created.body.id}`).expect(200);
    expect(read.body).toEqual(created.body);

    // Checked in the container itself, not through the API.
    expect(await db.admin.manager.count(OrderEntity)).toBe(1);
    expect(await db.admin.manager.count(JobEntity)).toBe(1);
    expect((await db.admin.manager.findOneByOrFail(ProductEntity, { id: product.id })).stock).toBe(3);
  });

  it('replays the same order for a repeated Idempotency-Key, and writes it once', async () => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().insertVia(products);
    const key = randomUUID();

    const first = await api().post('/orders').set('Idempotency-Key', key).send(orderBody(user, product, 1)).expect(201);
    const second = await api().post('/orders').set('Idempotency-Key', key).send(orderBody(user, product, 1)).expect(201);

    expect(second.body).toEqual(first.body);
    expect(await db.admin.manager.count(OrderEntity)).toBe(1);
  });

  it('answers 404 with a problem body for an order that does not exist', async () => {
    const { body } = await api().get('/orders/999').expect(404).expect('Content-Type', /application\/problem\+json/);
    expect(body).toMatchObject({ status: 404 });
  });

  it('answers 400 when the body breaks the spec (no user_id), and writes nothing', async () => {
    const product = await aProduct().insertVia(products);

    await api()
      .post('/orders')
      .set('Idempotency-Key', randomUUID())
      .send({ items: [{ product_id: Number(product.id), quantity: 1 }] })
      .expect(400);
    expect(await db.admin.manager.count(OrderEntity)).toBe(0);
  });

  it('answers 409 when stock is short, and leaves the stock as it was', async () => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().withStock(1).insertVia(products);

    await api().post('/orders').set('Idempotency-Key', randomUUID()).send(orderBody(user, product, 2)).expect(409);
    expect(await db.admin.manager.count(OrderEntity)).toBe(0);
    expect((await db.admin.manager.findOneByOrFail(ProductEntity, { id: product.id })).stock).toBe(1);
  });
});
