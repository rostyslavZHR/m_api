import type { Repository } from 'typeorm';
import { OrderEntity, UserEntity } from '../../src/entities/index.js';
import { OrdersRepository } from '../../src/orders/orders.repository.js';
import { ProductsRepository } from '../../src/products/products.repository.js';
import { aProduct, aUser, anOrder } from './testkit/builders.js';
import { startTestDatabase, type TestDatabase } from './testkit/postgres.js';

describe('OrdersRepository', () => {
  let db: TestDatabase;
  let orders: OrdersRepository;
  let products: ProductsRepository;
  let users: Repository<UserEntity>;

  beforeAll(async () => {
    db = await startTestDatabase();
    orders = new OrdersRepository(db.app.manager);
    products = new ProductsRepository(db.app.manager);
    users = db.app.getRepository(UserEntity);
  });

  beforeEach(async () => {
    await db.reset();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('inserts an order with its lines and reads both back through one JOIN', async () => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().insertVia(products);
    const order = await anOrder(user, product).withQuantity(2).insertVia(orders);

    expect(await orders.findById(order.id)).toMatchObject({
      id: order.id,
      status: 'paid',
      totalCents: '2000',
      items: [{ productId: product.id, quantity: 2, unitPriceCents: '1000', productName: product.name }],
    });
  });

  it('returns null for an order that does not exist', async () => {
    expect(await orders.findById('999')).toBeNull();
  });

  it('refuses a line pointing at a missing product: 23503, and saves no order', async () => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().insertVia(products);

    await expect(anOrder(user, product).withProductId('999').insertVia(orders)).rejects.toMatchObject({
      driverError: { code: '23503' },
    });
    expect(await db.app.manager.count(OrderEntity)).toBe(0);
  });

  it('refuses a second user with the same email: 23505 on users_email_key', async () => {
    await aUser().withEmail('taken@example.com').insertVia(users);

    await expect(aUser().withEmail('taken@example.com').insertVia(users)).rejects.toMatchObject({
      driverError: { code: '23505', constraint: 'users_email_key' },
    });
  });
});
