import type { DataSource } from 'typeorm';
import { OrderItemEntity } from '../entities/index.js';

// Every value arrives as a string: SUM over integer is bigint, SUM over numeric
// is numeric, and pg returns both as strings to avoid losing precision.
export interface RevenueByProductRow {
  product_id: string;
  name: string;
  units: string;
  revenue: string;
}

// Revenue per product over non-cancelled orders, highest first. A report row
// isn't an entity, so this is a query builder with getRawMany, not find().
export function revenueByProduct(dataSource: DataSource): Promise<RevenueByProductRow[]> {
  return (
    dataSource
      .getRepository(OrderItemEntity)
      // Starts from the line: ProductEntity has no @OneToMany back to its lines,
      // and the query builder joins through declared relations.
      .createQueryBuilder('item')
      // Revenue is history: a soft-deleted product still had its sales. Without
      // this, the query builder adds deleted_at IS NULL just like find() does.
      // It must come before the joins: each innerJoin() bakes the deleted_at
      // condition into its ON clause at call time, so a later withDeleted() is
      // too late for them.
      .withDeleted()
      .innerJoin('item.product', 'product')
      .innerJoin('item.order', 'orders')
      .select('product.id', 'product_id')
      .addSelect('product.name', 'name')
      .addSelect('SUM(item.quantity)', 'units')
      .addSelect('SUM(item.quantity * item.unitPrice)', 'revenue')
      .where('orders.status <> :cancelled', { cancelled: 'cancelled' })
      // product.id alone: it's the primary key, so product.name is functionally
      // dependent on it.
      .groupBy('product.id')
      // Lowercase snake_case aliases: Postgres folds unquoted identifiers, so a
      // camelCase alias would need quoting here.
      .orderBy('revenue', 'DESC')
      .getRawMany<RevenueByProductRow>()
  );
}
