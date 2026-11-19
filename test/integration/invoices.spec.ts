import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import { checkout } from '../../src/checkout/checkout.js';
import { CONSUMER, insertInvoice } from '../../src/consumer/invoices.js';
import { InvoiceEntity, type OrderEntity, ProcessedMessageEntity, UserEntity } from '../../src/entities/index.js';
import { type OrderPlacedEvent, toOrderPlacedEvent } from '../../src/messaging/order-placed.js';
import { ProductsRepository } from '../../src/products/products.repository.js';
import { aProduct, aUser } from './testkit/builders.js';
import { startTestDatabase, type TestDatabase } from './testkit/postgres.js';

// The invoicing consumer's effect, without a broker: insertInvoice is what the
// consumer runs per delivery, so a "duplicate delivery" is just a second call.
describe('invoicing consumer: idempotent on two levels', () => {
  let db: TestDatabase;
  let products: ProductsRepository;
  let users: Repository<UserEntity>;

  const placeOrder = async (): Promise<OrderEntity> => {
    const user = await aUser().insertVia(users);
    const product = await aProduct().withStock(5).insertVia(products);
    return checkout(db.app, { userId: user.id, items: [{ productId: product.id, quantity: 1 }] });
  };
  const eventFor = (order: OrderEntity, eventId = randomUUID()): OrderPlacedEvent => toOrderPlacedEvent(order, eventId);

  const counts = async () => ({
    invoices: await db.admin.manager.count(InvoiceEntity),
    processed: await db.admin.manager.count(ProcessedMessageEntity),
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

  it('the same eventId twice: applied once, then skipped as a duplicate', async () => {
    const event = eventFor(await placeOrder());

    expect(await insertInvoice(db.app, event)).toEqual({ outcome: 'applied' });
    expect(await insertInvoice(db.app, event)).toEqual({ outcome: 'skipped', reason: 'duplicate' });

    expect(await counts()).toEqual({ invoices: 1, processed: 1 });
    expect(await db.admin.manager.findOneByOrFail(ProcessedMessageEntity, { messageId: event.eventId })).toMatchObject({
      consumer: CONSUMER,
    });
  });

  it('the same eventId twice at the same moment: 1 invoice, 1 processed row, one call skipped', async () => {
    const event = eventFor(await placeOrder());

    // The second INSERT INTO processed_messages waits on the first one's unique-index
    // entry; when that commits, ON CONFLICT DO NOTHING returns no row: a duplicate.
    const results = await Promise.all([insertInvoice(db.app, event), insertInvoice(db.app, event)]);

    expect(results).toEqual(expect.arrayContaining([{ outcome: 'applied' }, { outcome: 'skipped', reason: 'duplicate' }]));
    expect(await counts()).toEqual({ invoices: 1, processed: 1 });
  });

  it('a failure inside the transaction leaves neither the processed row nor the invoice', async () => {
    const event = eventFor(await placeOrder());
    // Fails after the invoice row was written: the last statement of the transaction.
    await db.admin.query(`
      CREATE FUNCTION fail_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'invoice insert failed on purpose'; END $$;
      CREATE TRIGGER fail_invoice AFTER INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION fail_invoice();`);
    try {
      await expect(insertInvoice(db.app, event)).rejects.toThrow('invoice insert failed on purpose');
    } finally {
      await db.admin.query('DROP TRIGGER fail_invoice ON invoices; DROP FUNCTION fail_invoice();');
    }

    expect(await counts()).toEqual({ invoices: 0, processed: 0 });
    // The redelivery, with the failure gone, applies it once.
    expect(await insertInvoice(db.app, event)).toEqual({ outcome: 'applied' });
    expect(await counts()).toEqual({ invoices: 1, processed: 1 });
  });

  it('a different eventId for an order already invoiced: still 1 invoice, and the event is recorded as processed', async () => {
    const order = await placeOrder();
    const first = eventFor(order);
    const second = eventFor(order);

    expect(await insertInvoice(db.app, first)).toEqual({ outcome: 'applied' });
    expect(await insertInvoice(db.app, second)).toEqual({ outcome: 'skipped', reason: 'order already invoiced' });

    expect(await counts()).toEqual({ invoices: 1, processed: 2 });
  });
});
