import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Repository } from 'typeorm';
import { OrderEntity, ProductEntity, UserEntity } from '../../src/entities/index.js';
import { hashPassword } from '../../src/auth/password.js';
import { ProductsRepository } from '../../src/products/products.repository.js';
import { createTestApp } from '../integration/testkit/app.js';
import { aProduct, aUser } from '../integration/testkit/builders.js';
import { startTestDatabase, type TestDatabase } from '../integration/testkit/postgres.js';
import { startTestQueue, type TestRedis } from '../integration/testkit/redis.js';
import { accessTokenFor, bearer } from '../integration/testkit/tokens.js';

// Two levels: the role (who may write products) and ownership (whose order it is).
describe('Authorization (e2e)', () => {
  let db: TestDatabase;
  let queue: TestRedis;
  let app: NestExpressApplication;
  let users: Repository<UserEntity>;
  let product: ProductEntity;
  let alice: UserEntity;
  let bob: UserEntity;

  const tokenOf = (user: UserEntity) => accessTokenFor({ id: user.id, role: user.role });
  const as = async (user: UserEntity) => request.agent(app.getHttpServer()).set('Authorization', bearer(await tokenOf(user)));
  const anonymous = () => request(app.getHttpServer());
  const placeOrder = async (user: UserEntity) =>
    (
      await (await as(user))
        .post('/orders')
        .set('Idempotency-Key', randomUUID())
        .send({ items: [{ product_id: Number(product.id), quantity: 1 }] })
        .expect(201)
    ).body as { id: number };

  beforeAll(async () => {
    [db, queue] = await Promise.all([startTestDatabase(), startTestQueue()]);
    app = await createTestApp(db, { REDIS_QUEUE_URL: queue.url });
    users = db.app.getRepository(UserEntity);
  });

  beforeEach(async () => {
    await queue.cli('FLUSHALL');
    await db.reset();
    product = await aProduct().withStock(100).insertVia(new ProductsRepository(db.app.manager));
    alice = await aUser().insertVia(users);
    bob = await aUser().insertVia(users);
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.stop(), queue?.stop()]);
  });

  describe('the role level: POST /products (sellers and admins)', () => {
    const newProduct = { title: 'Desk lamp', description: 'Warm light', price_cents: 2500, stock: 3 };

    it('a customer gets 403 with a problem body, and nothing is written', async () => {
      const response = await (await as(alice)).post('/products').send(newProduct).expect(403);

      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(response.body).toMatchObject({ status: 403 });
      expect(await db.admin.manager.count(ProductEntity)).toBe(1);
    });

    it('a seller and an admin get 201 with the product', async () => {
      const seller = await aUser().withRole('seller').insertVia(users);
      const admin = await aUser().withRole('admin').insertVia(users);

      const created = await (await as(seller)).post('/products').send(newProduct).expect(201);
      await (await as(admin)).post('/products').send(newProduct).expect(201);

      expect(created.body).toEqual({ id: expect.any(Number), title: 'Desk lamp', price_cents: 2500, in_stock: true });
      await anonymous().get(`/products/${created.body.id}`).expect(200);
    });

    it('anonymous → 401: the write route is not public, the reads still are', async () => {
      await anonymous().post('/products').send(newProduct).expect(401);
      await anonymous().get('/products').expect(200);
      await anonymous().get(`/products/${product.id}`).expect(200);
      await anonymous().get(`/products/${product.id}/card`).expect(200);
    });

    it('a customer token with its role changed to admin → 401: the signature is checked first', async () => {
      const [header, payload, signature] = (await tokenOf(alice)).split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
      const forged = Buffer.from(JSON.stringify({ ...claims, role: 'admin' })).toString('base64url');

      await anonymous().post('/products').set('Authorization', bearer(`${header}.${forged}.${signature}`)).send(newProduct).expect(401);
    });

    it('the role comes from the token: a demoted seller still writes until that token expires', async () => {
      const password = 'correct horse battery staple';
      const seller = await aUser().withRole('seller').withPasswordHash(await hashPassword(password)).insertVia(users);
      const { accessToken, refreshToken } = (await anonymous().post('/auth/login').send({ email: seller.email, password }).expect(200))
        .body as { accessToken: string; refreshToken: string };
      await users.update({ id: seller.id }, { role: 'customer' });

      // The old token still says seller (up to 10 minutes).
      await anonymous().post('/products').set('Authorization', bearer(accessToken)).send(newProduct).expect(201);

      // A refresh reads the role from users again for the new token, but doesn't revoke
      // the old one: it still writes until its exp.
      const refreshed = (await anonymous().post('/auth/refresh').send({ refreshToken }).expect(200)).body as { accessToken: string };
      await anonymous().post('/products').set('Authorization', bearer(refreshed.accessToken)).send(newProduct).expect(403);
      await anonymous().post('/products').set('Authorization', bearer(accessToken)).send(newProduct).expect(201);
    });

    it('an invalid body → 400 (spec), before any write', async () => {
      const seller = await aUser().withRole('seller').insertVia(users);

      await (await as(seller)).post('/products').send({ title: '', price_cents: -1 }).expect(400);
    });
  });

  describe('the ownership level: orders', () => {
    it('GET /orders/:id: no token 401, the owner 200, another customer 403, an admin 200', async () => {
      const order = await placeOrder(alice);
      const admin = await aUser().withRole('admin').insertVia(users);

      await anonymous().get(`/orders/${order.id}`).expect(401);
      await (await as(alice)).get(`/orders/${order.id}`).expect(200);
      const foreign = await (await as(bob)).get(`/orders/${order.id}`).expect(403);
      await (await as(admin)).get(`/orders/${order.id}`).expect(200);

      expect(foreign.headers['content-type']).toMatch(/application\/problem\+json/);
    });

    it('someone else\'s order is 403, a missing one 404: the two are told apart', async () => {
      const order = await placeOrder(alice);

      await (await as(bob)).get(`/orders/${order.id}`).expect(403);
      await (await as(bob)).get(`/orders/${order.id + 1000}`).expect(404);
    });

    it('every route with an order id checks ownership: the status change and the event stream', async () => {
      const order = await placeOrder(alice);
      const asBob = await as(bob);

      await asBob.patch(`/orders/${order.id}/status`).send({ status: 'processing' }).expect(403);
      await asBob.get(`/orders/${order.id}/events`).expect(403);

      expect((await db.admin.manager.findOneByOrFail(OrderEntity, { id: String(order.id) })).status).toBe('paid');
      await (await as(alice)).patch(`/orders/${order.id}/status`).send({ status: 'processing' }).expect(200);
    });

    it('POST /orders with a user_id in the body → 400, and no order for anyone', async () => {
      await (await as(alice))
        .post('/orders')
        .set('Idempotency-Key', randomUUID())
        .send({ user_id: Number(bob.id), items: [{ product_id: Number(product.id), quantity: 1 }] })
        .expect(400);

      expect(await db.admin.manager.count(OrderEntity)).toBe(0);
    });

    it('POST /orders places the order for the token\'s user', async () => {
      const order = await placeOrder(alice);

      expect((await db.admin.manager.findOneByOrFail(OrderEntity, { id: String(order.id) })).userId).toBe(alice.id);
    });

    it('GET /orders lists only the caller\'s orders', async () => {
      const mine = [await placeOrder(alice), await placeOrder(alice)];
      await placeOrder(bob);

      const { body } = await (await as(alice)).get('/orders').expect(200);

      expect((body as { items: { id: number }[] }).items.map((o) => o.id)).toEqual(mine.map((o) => o.id));
    });

    it('the list pages through the caller\'s orders only', async () => {
      const mine = [await placeOrder(alice), await placeOrder(bob), await placeOrder(alice), await placeOrder(alice)].filter(
        (_, i) => i !== 1,
      );
      const asAlice = await as(alice);

      const first = (await asAlice.get('/orders?limit=2').expect(200)).body as { items: { id: number }[]; next_cursor: string };
      const second = (await asAlice.get(`/orders?limit=2&cursor=${first.next_cursor}`).expect(200)).body as {
        items: { id: number }[];
        next_cursor: string | null;
      };

      expect([...first.items, ...second.items].map((o) => o.id)).toEqual(mine.map((o) => o.id));
      expect(second.next_cursor).toBeNull();
    });
  });
});
