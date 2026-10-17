import { type EntityManager, MoreThan } from 'typeorm';
import { OrderEntity, OrderItemEntity } from '../entities/index.js';

export type NewOrderItem = Pick<OrderItemEntity, 'productId' | 'quantity' | 'unitPriceCents' | 'productName'>;

export type NewOrder = Pick<OrderEntity, 'status' | 'totalCents'> & {
  userId: string;
  items: NewOrderItem[];
};

// Takes an EntityManager so the same class works on the app's connection and
// inside checkout's transaction.
export class OrdersRepository {
  constructor(private readonly manager: EntityManager) {}

  // The items cascade, and save() wraps it all in one transaction.
  insert({ userId, status, totalCents, items }: NewOrder): Promise<OrderEntity> {
    return this.manager.save(
      this.manager.create(OrderEntity, {
        user: { id: userId },
        status,
        totalCents,
        items: items.map(({ productId, ...line }) =>
          this.manager.create(OrderItemEntity, { ...line, product: { id: productId } }),
        ),
      }),
    );
  }

  findById(id: string): Promise<OrderEntity | null> {
    return this.manager.findOne(OrderEntity, { where: { id }, relations: { items: true } });
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
}
