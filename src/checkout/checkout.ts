import type { DataSource, EntityManager } from 'typeorm';
import { inTransactionWithRetry, type RetryOptions } from '../common/transaction-retry.js';
import { JobEntity, OrderEntity, OrderItemEntity, ProductEntity, UserEntity } from '../entities/index.js';
import { InsufficientFundsError, OutOfStockError } from './checkout.errors.js';

export interface CheckoutInput {
  userId: string;
  productId: string;
  quantity: number;
}

// RETURNING runs raw, so its rows are keyed by database column names.
interface ReservedProduct {
  price_cents: string;
  name: string;
}

// Step 1: take the stock with one guarded, atomic UPDATE. The row lock it takes
// holds until commit, so the price returned is the price in force. Zero rows is
// the guard refusing — not an error from Postgres — so it has to be checked.
async function reserveStock(manager: EntityManager, { productId, quantity }: CheckoutInput): Promise<ReservedProduct> {
  const result = await manager
    .createQueryBuilder()
    .update(ProductEntity)
    .set({ stock: () => 'stock - :quantity' })
    // The soft-delete filter isn't applied to UPDATEs: a discontinued product
    // would keep selling without deleted_at IS NULL here.
    .where('id = :productId AND stock >= :quantity AND deleted_at IS NULL', { productId, quantity })
    // A string, not an array: the array form is resolved as property paths.
    .returning('price_cents, name')
    .execute();

  if (!result.affected) throw new OutOfStockError(productId, quantity);
  return (result.raw as ReservedProduct[])[0];
}

// Step 2: debit the balance the same way — only if it covers the total.
async function debitBalance(manager: EntityManager, userId: string, totalCents: bigint): Promise<void> {
  const result = await manager
    .createQueryBuilder()
    .update(UserEntity)
    .set({ balanceCents: () => 'balance_cents - :totalCents' })
    .where('id = :userId AND balance_cents >= :totalCents', { userId, totalCents: totalCents.toString() })
    .execute();

  if (!result.affected) throw new InsufficientFundsError(userId, totalCents);
}

// One transaction at READ COMMITTED, through the retry wrapper. Stock before
// balance, here and everywhere: one lock order means two checkouts can never
// wait on each other in a cycle. Either refusal throws, which rolls back
// everything before it — the stock comes back and no order exists.
// async, so every failure — a bad quantity included — arrives as a rejection.
export async function checkout(dataSource: DataSource, input: CheckoutInput, retry?: RetryOptions): Promise<OrderEntity> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new RangeError(`quantity must be a positive integer, got ${input.quantity}`);
  }

  return inTransactionWithRetry(
    dataSource,
    'READ COMMITTED',
    async (manager) => {
      const product = await reserveStock(manager, input);

      // bigint, so the total stays exact.
      const unitPriceCents = BigInt(product.price_cents);
      const totalCents = unitPriceCents * BigInt(input.quantity);

      await debitBalance(manager, input.userId, totalCents);

      // Paid, not new: the balance is already debited when the order is written.
      const order = await manager.save(
        manager.create(OrderEntity, {
          user: { id: input.userId },
          status: 'paid',
          totalCents: totalCents.toString(),
          items: [
            manager.create(OrderItemEntity, {
              product: { id: input.productId },
              quantity: input.quantity,
              unitPriceCents: unitPriceCents.toString(),
              productName: product.name,
            }),
          ],
        }),
      );

      // Same transaction: the job commits with the order or not at all. A worker
      // sends the receipt later, so a retried checkout can't send it twice.
      await manager.insert(JobEntity, { type: 'send-receipt', order: { id: order.id } });

      return order;
    },
    { label: 'checkout', ...retry },
  );
}
