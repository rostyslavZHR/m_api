import type { EntityManager } from 'typeorm';
import { ProductEntity } from '../entities/index.js';

export type NewProduct = Pick<ProductEntity, 'name' | 'description' | 'priceCents' | 'stock'>;
export type ReservedProduct = Pick<ProductEntity, 'name' | 'priceCents'>;

// RETURNING rows come back raw, keyed by column name.
interface ReservedProductRow {
  name: string;
  price_cents: string;
}

// Takes an EntityManager so the same class works on the app's connection and
// inside a transaction.
export class ProductsRepository {
  constructor(private readonly manager: EntityManager) {}

  findAll(): Promise<ProductEntity[]> {
    return this.manager.find(ProductEntity, { order: { id: 'ASC' } });
  }

  findById(id: string): Promise<ProductEntity | null> {
    return this.manager.findOneBy(ProductEntity, { id });
  }

  insert(product: NewProduct): Promise<ProductEntity> {
    return this.manager.save(this.manager.create(ProductEntity, product));
  }

  // One guarded UPDATE; null when it matches no row (too little stock, missing
  // or soft-deleted). The row lock holds until the caller commits.
  async reserveStock(id: string, quantity: number): Promise<ReservedProduct | null> {
    const result = await this.manager
      .createQueryBuilder()
      .update(ProductEntity)
      .set({ stock: () => 'stock - :quantity' })
      // UPDATEs skip TypeORM's soft-delete filter, hence deleted_at IS NULL.
      .where('id = :id AND stock >= :quantity AND deleted_at IS NULL', { id, quantity })
      // A string: the array form is read as property paths.
      .returning('name, price_cents')
      .execute();

    if (!result.affected) return null;
    const [row] = result.raw as ReservedProductRow[];
    return { name: row.name, priceCents: row.price_cents };
  }
}
