import { In, type EntityManager } from 'typeorm';
import { dataSource } from './data-source.js';
import { OrderEntity, OrderItemEntity, ProductEntity, UserEntity, type OrderStatus } from './entities/index.js';
import { BROKE_USER_EMAIL, RACE_PRODUCT, USER_BALANCE_CENTS } from './seed-fixtures.js';

// Idempotent without explicit ids: ids are GENERATED ALWAYS, so every row is
// found again by a natural key — email for users, name for products, and a
// fixed (user, created_at) for orders. Every value is fixed; nothing uses now().

const USER_COUNT = 10;
const ORDER_COUNT = 60; // the N+1 demo compares 10 and 50 orders
const USERS_CREATED_AT = new Date(Date.UTC(2025, 11, 1));
const FIRST_ORDER_AT = Date.UTC(2026, 0, 1);
const HOUR_MS = 3_600_000;
const INITIAL_STOCK = 100;

// USER_BALANCE_CENTS, BROKE_USER_EMAIL and RACE_PRODUCT live in seed-fixtures.ts, so the demos can
// look them up. RACE_PRODUCT stays out of PRODUCTS: orders pick their products
// by position in that list, so an 11th entry would reshuffle every seeded order.

const PRODUCTS = [
  { name: 'Шкіряні кросівки', description: 'Шкіряні кросівки для щоденного використання', priceCents: 349900 },
  { name: 'Зимова куртка', description: 'Тепла зимова куртка', priceCents: 599900 },
  { name: 'Спортивна сумка', description: 'Містка спортивна сумка', priceCents: 129900 },
  { name: 'Легкі черевики', description: 'Легкі черевики для міста', priceCents: 279900 },
  { name: 'Водонепроникна куртка', description: 'Водонепроникна куртка для походів', priceCents: 449900 },
  { name: 'Класичний ноутбук', description: 'Надійний ноутбук для роботи', priceCents: 3299900 },
  { name: 'Стильні кросівки', description: 'Стильні кросівки на кожен день', priceCents: 259900 },
  { name: 'Шкіряна сумка', description: 'Шкіряна сумка ручної роботи', priceCents: 189900 },
  { name: 'Зимові черевики', description: 'Теплі зимові черевики', priceCents: 399900 },
  { name: 'Легкий ноутбук', description: 'Легкий ноутбук для подорожей', priceCents: 2799900 },
];

interface SeededProduct {
  entity: ProductEntity;
  priceCents: number;
}

// Money is integer minor units end to end — summed as integers, never as
// decimal floats. bigint columns take strings in TypeORM.
const toBigint = (cents: number) => String(cents);

// 5% new, 20% shipped, 75% paid — the HW#12 split.
function statusFor(orderIndex: number): OrderStatus {
  if (orderIndex % 20 === 0) return 'new';
  if (orderIndex % 4 === 0) return 'shipped';
  return 'paid';
}

// The unique email makes this a true upsert. created_at and the balance are
// passed explicitly; on conflict upsert rewrites every supplied column, so each
// run resets them to the same values. Sorted by email, so users[i] is the same
// user on every run.
async function seedUsers(manager: EntityManager): Promise<UserEntity[]> {
  const emails = Array.from({ length: USER_COUNT }, (_, index) => `user${index + 1}@example.com`);
  await manager.upsert(
    UserEntity,
    emails.map((email) => ({ email, createdAt: USERS_CREATED_AT, balanceCents: toBigint(USER_BALANCE_CENTS) })),
    ['email'],
  );
  return manager.find(UserEntity, { where: { email: In(emails) }, order: { email: 'ASC' } });
}

// A separate upsert, so the oversized balance above never touches this user.
// Not returned: no seeded order belongs to them.
async function seedBrokeUser(manager: EntityManager): Promise<void> {
  await manager.upsert(
    UserEntity,
    { email: BROKE_USER_EMAIL, createdAt: USERS_CREATED_AT, balanceCents: toBigint(0) },
    ['email'],
  );
}

// No unique key on name, so look up first. withDeleted, or a soft-deleted
// product looks missing and a second run inserts a duplicate name.
async function seedProducts(manager: EntityManager): Promise<SeededProduct[]> {
  const seeded: SeededProduct[] = [];
  for (const product of PRODUCTS) {
    let entity = await manager.findOne(ProductEntity, { where: { name: product.name }, withDeleted: true });
    if (!entity) {
      entity = await manager.save(
        manager.create(ProductEntity, {
          name: product.name,
          description: product.description,
          priceCents: toBigint(product.priceCents),
          stock: INITIAL_STOCK,
        }),
      );
    }
    seeded.push({ entity, priceCents: product.priceCents });
  }
  return seeded;
}

// Looked up by name like the others, so it's created once. A second run doesn't
// reset its stock after a race — the race demo resets its own preconditions.
async function seedRaceProduct(manager: EntityManager): Promise<void> {
  const existing = await manager.findOne(ProductEntity, { where: { name: RACE_PRODUCT.name }, withDeleted: true });
  if (existing) return;
  await manager.save(
    manager.create(ProductEntity, {
      name: RACE_PRODUCT.name,
      description: RACE_PRODUCT.description,
      priceCents: toBigint(RACE_PRODUCT.priceCents),
      stock: RACE_PRODUCT.stock,
    }),
  );
}

// 1–3 lines per order. Offsets 0, 3, 6 out of 10 keep an order's lines on
// different products, or the (order_id, product_id) primary key rejects the
// second line.
function linesFor(orderIndex: number, products: SeededProduct[]) {
  const lineCount = 1 + (orderIndex % 3);
  return Array.from({ length: lineCount }, (_, lineIndex) => ({
    ...products[(orderIndex + lineIndex * 3) % products.length],
    quantity: 1 + ((orderIndex + lineIndex) % 3),
  }));
}

// A fixed (user, created_at) is the order's identity: an existing one is skipped.
async function seedOrders(manager: EntityManager, users: UserEntity[], products: SeededProduct[]) {
  for (let orderIndex = 0; orderIndex < ORDER_COUNT; orderIndex++) {
    const user = users[orderIndex % users.length];
    const createdAt = new Date(FIRST_ORDER_AT + orderIndex * HOUR_MS);

    const existing = await manager.findOne(OrderEntity, { where: { user: { id: user.id }, createdAt } });
    if (existing) continue;

    const lines = linesFor(orderIndex, products);
    const totalCents = lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);

    const order = manager.create(OrderEntity, {
      user,
      status: statusFor(orderIndex),
      totalCents: toBigint(totalCents),
      createdAt,
      items: lines.map((line) =>
        manager.create(OrderItemEntity, {
          product: line.entity,
          quantity: line.quantity,
          unitPriceCents: toBigint(line.priceCents),
          productName: line.entity.name,
        }),
      ),
    });
    await manager.save(order); // cascade: true inserts the lines
  }
}

await dataSource.initialize();
try {
  // One transaction: a crash halfway leaves nothing, so the next run starts clean.
  await dataSource.transaction(async (manager) => {
    const users = await seedUsers(manager);
    await seedBrokeUser(manager);
    const products = await seedProducts(manager);
    await seedRaceProduct(manager);
    await seedOrders(manager, users, products);
  });
} finally {
  await dataSource.destroy();
}
