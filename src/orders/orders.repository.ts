import { type EntityManager, MoreThan } from 'typeorm';

import {
  OrderEntity,
  OrderEventEntity,
  OrderItemEntity,
  type OrderStatus,
} from '../entities/index.js';

export type NewOrderItem = Pick<
  OrderItemEntity,
  'productId' | 'quantity' | 'unitPriceCents' | 'productName'
>;

export type NewOrder = Pick<OrderEntity, 'status' | 'totalCents'> & {
  userId: string;
  items: NewOrderItem[];
};

// Ids are strings here, as pg returns bigint; the service converts at the API boundary.
export interface StatusChange {
  orderId: string;
  from: OrderStatus;
  to: OrderStatus;
}

// One row of order_events. `from` is null only for the creation event (checkout).
export interface NewOrderEvent {
  orderId: string;
  from: OrderStatus | null;
  to: OrderStatus;
}

// Takes an EntityManager so the same class works on the app's connection and
// inside checkout's transaction.
export class OrdersRepository {
  constructor(private readonly manager: EntityManager) {}

  // The items cascade, and save() wraps it all in one transaction.
  insert({
    userId,
    status,
    totalCents,
    items,
  }: NewOrder): Promise<OrderEntity> {
    return this.manager.save(
      this.manager.create(OrderEntity, {
        user: { id: userId },
        status,
        totalCents,
        items: items.map(({ productId, ...line }) =>
          this.manager.create(OrderItemEntity, {
            ...line,
            product: { id: productId },
          }),
        ),
      }),
    );
  }

  findById(id: string): Promise<OrderEntity | null> {
    return this.manager.findOne(OrderEntity, {
      where: { id },
      relations: { items: true },
    });
  }

  // Keyset pagination by id: ids are unique and only grow. created_at can't be
  // the key here, because a JS Date drops its microseconds, so a cursor built
  // from one would sit just before the row it came from.
  list(limit: number, afterId?: string): Promise<OrderEntity[]> {
    return this.manager.find(OrderEntity, {
      where: afterId ? { id: MoreThan(afterId) } : {},
      relations: { items: true },
      order: { id: 'ASC' },
      take: limit,
    });
  }

  // Guarded: changes the status only if it's still `from`. 0 rows means it was
  // changed since it was read (a concurrent request), and the caller answers 409.
  async updateStatus({ orderId, from, to }: StatusChange): Promise<boolean> {
    const result = await this.manager
      .createQueryBuilder()
      .update(OrderEntity)
      .set({ status: to })
      .where('id = :orderId AND status = :from', { orderId, from })
      .execute();

    return result.affected === 1;
  }

  // Call it AFTER updateStatus, in the same transaction: the update's row lock
  // serializes changes to one order, so their event ids follow commit order.
  // Inserted first, a later commit could carry a smaller id, and Last-Event-ID
  // replay (id > cursor) would skip it. save() fills in id and createdAt.
  insertEvent({ orderId, from, to }: NewOrderEvent): Promise<OrderEventEntity> {
    return this.manager.save(
      this.manager.create(OrderEventEntity, {
        fromStatus: from,
        toStatus: to,
        order: { id: orderId },
      }),
    );
  }
}
