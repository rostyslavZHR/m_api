import { LessThan } from 'typeorm';
import { InsufficientFundsError, OutOfStockError } from './checkout/checkout.errors.js';
import { checkout } from './checkout/checkout.js';
import { runtimeDataSource as dataSource } from './runtime-data-source.js';
import { JobEntity, OrderEntity, OrderItemEntity, ProductEntity, UserEntity } from './entities/index.js';
import { BROKE_USER_EMAIL, RACE_BUYER_EMAIL, RACE_PRODUCT, USER_BALANCE_CENTS } from './seed-fixtures.js';

// 50 checkouts of one unit each, fired at once at a product with 10 in stock.
// What it shows: under concurrency there's no oversell — exactly 10 succeed,
// stock ends at 0 and never goes negative — and no half-done work: a failed
// checkout leaves no order and gets its stock back; every success leaves one
// order, one line, one job and one exact debit.
//
// What makes it hold, by KB question (dev-notes, postgres.md):
//   #93 — the guarded atomic UPDATE … WHERE stock >= n RETURNING: the check and
//         the change are one statement, and 0 affected rows is the guard refusing.
//   #92 — at READ COMMITTED a writer that waited for the row lock re-checks its
//         WHERE against the committed row, so the 11th buyer finds stock 0.
//   #91 — all four steps in one transaction; a throw rolls everything back (the
//         sanity check proves it with the broke user).
//   #96 — one lock order, product before user, so the 50 can't deadlock.
//   #95 — the retry wrapper is in the path, and `retries: 0` shows correct code
//         never needed it; demo-retry.ts is where it's provoked.

const ATTEMPTS = 50;

const productRepository = dataSource.getRepository(ProductEntity);
const userRepository = dataSource.getRepository(UserEntity);
const orderRepository = dataSource.getRepository(OrderEntity);
const orderItemRepository = dataSource.getRepository(OrderItemEntity);
const jobRepository = dataSource.getRepository(JobEntity);

interface Counts {
  orders: number;
  orderItems: number;
  jobs: number;
}

const countRows = async (): Promise<Counts> => ({
  orders: await orderRepository.count(),
  orderItems: await orderItemRepository.count(),
  jobs: await jobRepository.count(),
});

const stockOf = async (productId: string) => (await productRepository.findOneByOrFail({ id: productId })).stock;

// Collects every check, prints it, and decides the exit code at the end.
const failures: string[] = [];
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) failures.push(label);
}

// E1 — reset the preconditions — the stock and the buyer's balance — so every
// run starts from the same state and prints the same output.
async function setUp() {
  const product = await productRepository.findOneByOrFail({ name: RACE_PRODUCT.name });
  await productRepository.update({ id: product.id }, { stock: RACE_PRODUCT.stock });

  await userRepository.update({ email: RACE_BUYER_EMAIL }, { balanceCents: String(USER_BALANCE_CENTS) });
  const buyer = await userRepository.findOneByOrFail({ email: RACE_BUYER_EMAIL });
  const brokeUser = await userRepository.findOneByOrFail({ email: BROKE_USER_EMAIL });

  return { product, buyer, brokeUser, before: await countRows() };
}

// E2 — the broke user buys one unit. checkout() takes the stock before it
// debits the balance, so stock still at 10 afterwards proves the decrement was
// rolled back when the debit failed — and no order or job may be left behind.
async function sanityCheck(productId: string, brokeUserId: string, before: Counts) {
  console.log('\nSanity check — broke user buys 1:');
  let rejection: unknown;
  try {
    await checkout(dataSource, { userId: brokeUserId, productId, quantity: 1 });
  } catch (error) {
    rejection = error;
  }
  check('rejected with InsufficientFundsError', rejection instanceof InsufficientFundsError, true);
  check('stock after the rollback', await stockOf(productId), RACE_PRODUCT.stock);

  const after = await countRows();
  check('new orders', after.orders - before.orders, 0);
  check('new jobs', after.jobs - before.jobs, 0);
}

await dataSource.initialize();
try {
  const { product, buyer, brokeUser, before } = await setUp();
  const startBalance = BigInt(buyer.balanceCents);
  const priceCents = BigInt(product.priceCents);

  await sanityCheck(product.id, brokeUser.id, before);

  // E3 — all at once, with Promise.all and no queue in the app (the pool's own
  // queue of 10 connections is fine). Each call settles into a result rather
  // than rejecting, so one failure can't abort the batch and lose the other 49.
  // One buyer for every call puts the balance under contention too.
  let retries = 0;
  const results = await Promise.all(
    Array.from({ length: ATTEMPTS }, () =>
      checkout(dataSource, { userId: buyer.id, productId: product.id, quantity: 1 }, { onRetry: () => retries++ }).then(
        () => ({ ok: true as const }),
        (reason: unknown) => ({ ok: false as const, reason }),
      ),
    ),
  );

  // E4 — anything but OutOfStockError is a real failure, not an expected rejection.
  const successes = results.filter((result) => result.ok).length;
  const unexpected = results.filter((result) => !result.ok && !(result.reason instanceof OutOfStockError));
  for (const result of unexpected) console.error('  unexpected rejection:', 'reason' in result ? result.reason : result);

  const finalStock = await stockOf(product.id);
  const negativeStockRows = await productRepository.count({ where: { stock: LessThan(0) }, withDeleted: true });

  // E5 — the brief's wording.
  console.log(`\nспроб: ${ATTEMPTS}`);
  console.log(`успішних: ${successes}`);
  console.log(`фінальний stock: ${finalStock}`);
  console.log(`рядків із відʼємним stock: ${negativeStockRows}`);
  // Counted, not inferred from the absence of [retry] lines.
  console.log(`retries: ${retries}`);

  // E6 — and everything else that must hold. Orders, lines and jobs are
  // measured against the counts taken after the sanity check, which created none.
  const after = await countRows();
  const finalBalance = BigInt((await userRepository.findOneByOrFail({ id: buyer.id })).balanceCents);

  console.log('\nChecks:');
  check('successes', successes, RACE_PRODUCT.stock);
  check('final stock', finalStock, 0);
  check('rows with negative stock', negativeStockRows, 0);
  check('unexpected rejections', unexpected.length, 0);
  check('new orders = successes', after.orders - before.orders, successes);
  // One line per order: proves the cascade filled the composite key from { id } partials.
  check('new order lines = successes', after.orderItems - before.orderItems, successes);
  check('new jobs = successes', after.jobs - before.jobs, successes);
  check('buyer balance = start − successes × price', finalBalance, startBalance - BigInt(successes) * priceCents);

  if (failures.length) {
    console.error(`\nFAILED: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll checks passed.');
  }
} finally {
  await dataSource.destroy();
}
