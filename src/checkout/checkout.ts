import type { DataSource, EntityManager } from 'typeorm';
import { inTransactionWithRetry, type RetryOptions } from '../common/transaction-retry.js';
import { JobEntity, type OrderEntity, UserEntity } from '../entities/index.js';
import { type NewOrderItem, OrdersRepository } from '../orders/orders.repository.js';
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
async function debitBalance(manager: EntityManager, userId: string, totalCents: bigint): Promise<void> {
  const result = await manager
    .createQueryBuilder()
    .update(UserEntity)
    .set({ balanceCents: () => 'balance_cents - :totalCents' })
    .where('id = :userId AND balance_cents >= :totalCents', { userId, totalCents: totalCents.toString() })
    .execute();

  if (!result.affected) throw new InsufficientFundsError(userId, totalCents);
}

// One transaction at READ COMMITTED, through the retry wrapper. One lock order
// everywhere — products by ascending id, then the user — so two checkouts can
// never wait on each other in a cycle. Any refusal throws, which rolls back
// everything before it: the stock comes back and no order exists.
// async, so every failure — a bad quantity included — arrives as a rejection.
export async function checkout(dataSource: DataSource, input: CheckoutInput, retry?: RetryOptions): Promise<OrderEntity> {
  if (input.items.length === 0) {
    throw new RangeError('an order needs at least one item');
  }
  for (const { quantity } of input.items) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new RangeError(`quantity must be a positive integer, got ${quantity}`);
    }
  }
  if (new Set(input.items.map((item) => item.productId)).size !== input.items.length) {
    throw new RangeError('each product can appear only once in an order');
  }
  const items = [...input.items].sort((a, b) => (BigInt(a.productId) < BigInt(b.productId) ? -1 : 1));

  return inTransactionWithRetry(
    dataSource,
    'READ COMMITTED',
    async (manager) => {
      const products = new ProductsRepository(manager);
      const lines: NewOrderItem[] = [];
      let totalCents = 0n;

      for (const { productId, quantity } of items) {
        const product = await products.reserveStock(productId, quantity);
        if (!product) throw new OutOfStockError(productId, quantity);

        lines.push({ productId, quantity, unitPriceCents: product.priceCents, productName: product.name });
        // bigint, so the total stays exact.
        totalCents += BigInt(product.priceCents) * BigInt(quantity);
      }

      await debitBalance(manager, input.userId, totalCents);

      // Paid, not new: the balance is already debited when the order is written.
      const order = await new OrdersRepository(manager).insert({
        userId: input.userId,
        status: 'paid',
        totalCents: totalCents.toString(),
        items: lines,
      });

      // Same transaction: the job commits with the order or not at all. A worker
      // sends the receipt later, so a retried checkout can't send it twice.
      await manager.insert(JobEntity, { type: 'send-receipt', order: { id: order.id } });

      return order;
    },
    { label: 'checkout', ...retry },
  );
}
