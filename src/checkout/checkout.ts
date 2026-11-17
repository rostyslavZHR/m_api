import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import {
  inTransactionWithRetry,
  type RetryOptions,
} from '../common/transaction-retry.js';
import { JobEntity, type OrderEntity, UserEntity } from '../entities/index.js';
import { toOrderPlacedEvent } from '../messaging/order-placed.js';
import { OutboxRepository } from '../messaging/outbox.repository.js';
import {
  IdempotencyKeysRepository,
  type KeyRef,
} from '../orders/idempotency-keys.repository.js';
import {
  type NewOrderItem,
  OrdersRepository,
} from '../orders/orders.repository.js';
import { ProductsRepository } from '../products/products.repository.js';
import { InsufficientFundsError, OutOfStockError } from './checkout.errors.js';

export interface CheckoutItem {
  productId: string;
  quantity: number;
}

export interface CheckoutInput {
  userId: string;
  // Each product at most once (order lines are keyed by order and product).
  items: CheckoutItem[];
}

// Debits the balance only if it covers the total, in one guarded UPDATE.
async function debitBalance(
  manager: EntityManager,
  userId: string,
  totalCents: bigint,
): Promise<void> {
  const result = await manager
    .createQueryBuilder()
    .update(UserEntity)
    .set({ balanceCents: () => 'balance_cents - :totalCents' })
    .where('id = :userId AND balance_cents >= :totalCents', {
      userId,
      totalCents: totalCents.toString(),
    })
    .execute();

  if (!result.affected) throw new InsufficientFundsError(userId, totalCents);
}

// Checked before any transaction starts; returns the items in lock order (products
// by ascending id).
function validatedItems(input: CheckoutInput): CheckoutItem[] {
  if (input.items.length === 0) {
    throw new RangeError('an order needs at least one item');
  }
  for (const { quantity } of input.items) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new RangeError(
        `quantity must be a positive integer, got ${quantity}`,
      );
    }
  }
  if (
    new Set(input.items.map((item) => item.productId)).size !==
    input.items.length
  ) {
    throw new RangeError('each product can appear only once in an order');
  }
  return [...input.items].sort((a, b) =>
    BigInt(a.productId) < BigInt(b.productId) ? -1 : 1,
  );
}

// The order itself, inside the caller's transaction: stock, balance, the order and
// its lines, its creation event, the receipt job and the outbox row. One lock
// order everywhere (products by ascending id, then the user), so two checkouts can
// never wait on each other in a cycle. Any refusal throws, which rolls back
// everything before it: the stock comes back and no order exists.
async function placeOrder(
  manager: EntityManager,
  userId: string,
  items: CheckoutItem[],
): Promise<OrderEntity> {
  const products = new ProductsRepository(manager);
  const lines: NewOrderItem[] = [];
  let totalCents = 0n;

  for (const { productId, quantity } of items) {
    const product = await products.reserveStock(productId, quantity);
    if (!product) throw new OutOfStockError(productId, quantity);

    lines.push({
      productId,
      quantity,
      unitPriceCents: product.priceCents,
      productName: product.name,
    });
    // bigint, so the total stays exact.
    totalCents += BigInt(product.priceCents) * BigInt(quantity);
  }

  await debitBalance(manager, userId, totalCents);

  // Paid, not new: the balance is already debited when the order is written.
  const orders = new OrdersRepository(manager);
  const order = await orders.insert({
    userId,
    status: 'paid',
    totalCents: totalCents.toString(),
    items: lines,
  });

  // The creation event (null → paid), so a stream's history starts at checkout.
  // Not published: no one can be subscribed to an order that didn't exist yet.
  await orders.insertEvent({ orderId: order.id, from: null, to: 'paid' });

  // Same transaction: the job commits with the order or not at all. A worker
  // sends the receipt later, so a retried checkout can't send it twice.
  await manager.insert(JobEntity, {
    type: 'send-receipt',
    order: { id: order.id },
  });

  // The order.placed event, in the same transaction: one COMMIT for the order,
  // its items, the stock, the balance and the event, so an event exists if and
  // only if its order does. Built from the saved order (its id, total and prices
  // as charged). Through this transaction's manager; the relay publishes it
  // later, and nothing here talks to the broker, which can't roll back. A
  // retried attempt rolls its row back and gets a new id; only the committed
  // one exists.
  const event = toOrderPlacedEvent(order, randomUUID());
  await new OutboxRepository(manager).add({
    id: event.eventId,
    aggregateType: 'order',
    aggregateId: order.id,
    type: event.type,
    payload: event,
  });

  return order;
}

// One transaction at READ COMMITTED, through the retry wrapper.
// async, so every failure — a bad quantity included — arrives as a rejection.
export async function checkout(
  dataSource: DataSource,
  input: CheckoutInput,
  retry?: RetryOptions,
): Promise<OrderEntity> {
  const items = validatedItems(input);
  return inTransactionWithRetry(
    dataSource,
    'READ COMMITTED',
    (manager) => placeOrder(manager, input.userId, items),
    { label: 'checkout', ...retry },
  );
}

export type KeyedCheckout =
  | { replayed: false; order: OrderEntity }
  // The key was already used: nothing was created. fingerprint is the first
  // request's, for the caller to compare with this one's.
  | { replayed: true; orderId: string; fingerprint: string };

// checkout() behind an Idempotency-Key (level 3), still one transaction. Its first
// statement claims the key; only the request that claims it creates the order, and
// the key row, the order and its event commit together. Inside the retried
// callback, so a retried attempt rolls its own key row back with everything else.
// A failure (out of stock, no money) rolls the key back too: only a created order
// is remembered, and a retry with the same key tries again.
export async function checkoutWithKey(
  dataSource: DataSource,
  input: CheckoutInput,
  { key, fingerprint }: { key: string; fingerprint: string },
  retry?: RetryOptions,
): Promise<KeyedCheckout> {
  const items = validatedItems(input);
  const ref: KeyRef = { userId: input.userId, key };
  return inTransactionWithRetry(
    dataSource,
    'READ COMMITTED',
    async (manager): Promise<KeyedCheckout> => {
      const keys = new IdempotencyKeysRepository(manager);
      if (!(await keys.claim(ref, fingerprint))) {
        const stored = await keys.find(ref);
        return { replayed: true, ...stored };
      }
      const order = await placeOrder(manager, input.userId, items);
      await keys.attachOrder(ref, order.id);
      return { replayed: false, order };
    },
    { label: 'checkout', ...retry },
  );
}
