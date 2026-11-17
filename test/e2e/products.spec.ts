import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Repository } from 'typeorm';
import { UserEntity } from '../../src/entities/index.js';
import { OrdersRepository } from '../../src/orders/orders.repository.js';
import { ProductsRepository } from '../../src/products/products.repository.js';
import { createTestApp } from '../integration/testkit/app.js';
import { aProduct, aUser, anOrder } from '../integration/testkit/builders.js';
import { startTestDatabase, type TestDatabase } from '../integration/testkit/postgres.js';

// The testkit points the cache at a port nothing listens on, so every card read is
// a miss: this checks the endpoint and its response contract, not the cache (see
// test/integration/product-card.spec.ts for that).
describe('Products API (e2e)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let products: ProductsRepository;

  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp(db);
    products = new ProductsRepository(db.app.manager);
  });

  beforeEach(async () => {
    await db.reset();
  });

  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  it('GET /products/:id/card returns the card, from the database when the cache is down', async () => {
    const product = await aProduct().withStock(3).withPriceCents('2500').insertVia(products);
    const user = await aUser().insertVia(db.app.getRepository(UserEntity) as Repository<UserEntity>);
    await anOrder(user, product).withQuantity(2).insertVia(new OrdersRepository(db.app.manager));

    const response = await api().get(`/products/${product.id}/card`).expect(200);

    expect(response.headers['x-cache']).toBe('MISS');
    expect(response.body).toMatchObject({
      id: Number(product.id),
      price_cents: 2500,
      stock: 3,
      in_stock: true,
      sales: { units_sold: 2, orders: 1, buyers: 1, revenue_cents: 5000 },
      bought_together: [],
    });
  });

  it('GET /products/:id/card for a missing product → 404 problem+json', async () => {
    const response = await api().get('/products/999999/card').expect(404);

    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});
