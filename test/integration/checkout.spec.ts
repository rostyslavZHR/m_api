import type { Repository } from 'typeorm';
import { checkout } from '../../src/checkout/checkout.js';
import { OutOfStockError } from '../../src/checkout/checkout.errors.js';
import { JobEntity, OrderEntity, OutboxEntity, ProductEntity, UserEntity } from '../../src/entities/index.js';
import { orderPlacedSchema } from '../../src/messaging/order-placed.js';
import { ProductsRepository } from '../../src/products/products.repository.js';
import { aProduct, aUser } from './testkit/builders.js';
import { startTestDatabase, type TestDatabase } from './testkit/postgres.js';

describe('checkout', () => {
  let db: TestDatabase;
  let products: ProductsRepository;
  let users: Repository<UserEntity>;

  const countOrdersAndJobs = async () => ({
    orders: await db.app.manager.count(OrderEntity),
    jobs: await db.app.manager.count(JobEntity),
  });

  beforeAll(async () => {
    db = await startTestDatabase();
    products = new ProductsRepository(db.app.manager);
    users = db.app.getRepository(UserEntity);
  });

  beforeEach(async () => {
    await db.reset();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('sells: one paid order, stock and balance debited, one receipt job', async () => {
    const user = await aUser().withBalanceCents('10000').insertVia(users);
    const product = await aProduct().withStock(3).withPriceCents('2500').insertVia(products);

    const order = await checkout(db.app, { userId: user.id, items: [{ productId: product.id, quantity: 2 }] });

    expect(order).toMatchObject({ status: 'paid', totalCents: '5000' });
    expect(await countOrdersAndJobs()).toEqual({ orders: 1, jobs: 1 });
    expect((await products.findById(product.id))?.stock).toBe(1);
    expect((await users.findOneByOrFail({ id: user.id })).balanceCents).toBe('5000');
  });

  it('refuses when the guarded UPDATE matches no row: OutOfStockError, nothing written', async () => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().withStock(1).insertVia(products);

    await expect(checkout(db.app, { userId: user.id, items: [{ productId: product.id, quantity: 2 }] })).rejects.toBeInstanceOf(
      OutOfStockError,
    );
    expect(await countOrdersAndJobs()).toEqual({ orders: 0, jobs: 0 });
    expect((await products.findById(product.id))?.stock).toBe(1);
    expect((await users.findOneByOrFail({ id: user.id })).balanceCents).toBe('100000');
  });

  it('rejects a product listed twice before touching the database', async () => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().withStock(5).insertVia(products);
    const line = { productId: product.id, quantity: 1 };

    await expect(checkout(db.app, { userId: user.id, items: [line, line] })).rejects.toBeInstanceOf(RangeError);
    expect((await products.findById(product.id))?.stock).toBe(5);
  });

  it('50 concurrent checkouts for 10 units: exactly 10 sell, stock ends at 0, never below', async () => {
    const user = await aUser().withBalanceCents('1000000').insertVia(users);
    const product = await aProduct().withStock(10).insertVia(products);

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => checkout(db.app, { userId: user.id, items: [{ productId: product.id, quantity: 1 }] })),
    );
    const rejections = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
    expect(rejections.every((reason) => reason instanceof OutOfStockError)).toBe(true);
    expect(await countOrdersAndJobs()).toEqual({ orders: 10, jobs: 10 });
    expect(await db.app.manager.countBy(ProductEntity, { id: product.id, stock: 0 })).toBe(1);
  });

  it('writes exactly one outbox row in the same commit: order.placed v2, built from the saved order', async () => {
    const user = await aUser().withBalanceCents('10000').insertVia(users);
    const product = await aProduct().withStock(3).withPriceCents('2500').insertVia(products);

    const order = await checkout(db.app, { userId: user.id, items: [{ productId: product.id, quantity: 2 }] });

    const rows = await db.admin.manager.find(OutboxEntity);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ aggregateType: 'order', aggregateId: order.id, type: 'order.placed', publishedAt: null, attempts: 0 });
    // The strict producer schema: v2, and no field nobody chose.
    const payload = orderPlacedSchema.parse(row.payload);
    expect(payload).toEqual({
      eventId: row.id,
      type: 'order.placed',
      version: 2,
      occurredAt: order.createdAt.toISOString(),
      data: {
        orderId: Number(order.id),
        userId: Number(user.id),
        totalCents: '5000',
        items: [{ productId: Number(product.id), quantity: 2, unitPriceCents: '2500' }],
      },
    });
  });

  it('a failure after the outbox insert, inside the transaction, leaves 0 orders and 0 outbox rows', async () => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().withStock(3).insertVia(products);
    // Fails every outbox insert, after the row was written: the last statement of
    // the checkout transaction. Raised in the database, so no test hook in the code.
    await db.admin.query(`
      CREATE FUNCTION fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'outbox insert failed on purpose'; END $$;
      CREATE TRIGGER fail_outbox AFTER INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_outbox();`);
    try {
      await expect(checkout(db.app, { userId: user.id, items: [{ productId: product.id, quantity: 1 }] })).rejects.toThrow(
        'outbox insert failed on purpose',
      );
    } finally {
      await db.admin.query('DROP TRIGGER fail_outbox ON outbox; DROP FUNCTION fail_outbox();');
    }

    expect(await countOrdersAndJobs()).toEqual({ orders: 0, jobs: 0 });
    expect(await db.admin.manager.count(OutboxEntity)).toBe(0);
    expect((await products.findById(product.id))?.stock).toBe(3);
  });
});
