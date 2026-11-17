import type { EntityManager } from 'typeorm';
import { ProductEntity } from '../entities/index.js';

export type NewProduct = Pick<ProductEntity, 'name' | 'description' | 'priceCents' | 'stock'>;
export type ReservedProduct = Pick<ProductEntity, 'name' | 'priceCents'>;

// RETURNING rows come back raw, keyed by column name.
interface ReservedProductRow {
  name: string;
  price_cents: string;
}

// The product card (GET /products/{id}/card): JSON-safe as it leaves the
// repository (numbers, an ISO string, no Date, no bigint string), so a cache hit
// returns exactly what a miss returns. Nothing per user: the cached copy is shared.
export interface ProductCard {
  id: number;
  title: string;
  description: string;
  price_cents: number;
  stock: number;
  in_stock: boolean;
  sales: {
    units_sold: number;
    orders: number;
    buyers: number;
    revenue_cents: number;
    units_sold_30d: number;
    last_ordered_at: string | null;
  };
  bought_together: { product_id: number; title: string; orders: number }[];
}

interface ProductCardRow {
  id: string;
  name: string;
  description: string;
  price_cents: string;
  stock: number;
  units_sold: number;
  orders: number;
  buyers: number;
  revenue_cents: string;
  units_sold_30d: number;
  last_ordered_at: Date | null;
  bought_together: ProductCard['bought_together'];
}

// How many times the card's SQL actually ran in this process: counted in
// findCard, where the query executes, so a cache hit can't be miscounted as a
// database call. Read by the tests and the Phase G demo.
export const cardQueries = { count: 0 };

// The card's aggregates, over every order of the product except cancelled ones:
// units, orders, distinct buyers, revenue (at the prices paid), the last 30 days,
// and the three products most often bought in the same orders (a self-join of
// order_items, which grows with orders × lines).
const CARD_SQL = `
  WITH product AS (
    SELECT id, name, description, price_cents, stock
    FROM products WHERE id = $1 AND deleted_at IS NULL
  ),
  sales AS (
    SELECT coalesce(sum(oi.quantity), 0)::int AS units_sold,
           count(DISTINCT o.id)::int AS orders,
           count(DISTINCT o.user_id)::int AS buyers,
           coalesce(sum(oi.quantity * oi.unit_price_cents), 0)::text AS revenue_cents,
           coalesce(sum(oi.quantity) FILTER (WHERE o.created_at > now() - interval '30 days'), 0)::int
             AS units_sold_30d,
           max(o.created_at) AS last_ordered_at
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id = $1 AND o.status <> 'cancelled'
  ),
  together AS (
    SELECT other.product_id, p.name, count(*)::int AS orders
    FROM order_items mine
    JOIN orders o ON o.id = mine.order_id AND o.status <> 'cancelled'
    JOIN order_items other ON other.order_id = mine.order_id AND other.product_id <> mine.product_id
    JOIN products p ON p.id = other.product_id AND p.deleted_at IS NULL
    WHERE mine.product_id = $1
    GROUP BY other.product_id, p.name
    ORDER BY orders DESC, other.product_id
    LIMIT 3
  )
  SELECT product.*, sales.*,
         (SELECT coalesce(json_agg(json_build_object(
                   'product_id', t.product_id::int, 'title', t.name, 'orders', t.orders)
                   ORDER BY t.orders DESC, t.product_id), '[]'::json)
          FROM together t) AS bought_together
  FROM product CROSS JOIN sales`;

// Takes an EntityManager so the same class works on the app's connection and
// inside a transaction.
export class ProductsRepository {
  constructor(private readonly manager: EntityManager) {}

  // null when the product doesn't exist or is soft-deleted.
  async findCard(id: string): Promise<ProductCard | null> {
    cardQueries.count++;
    const [row] = (await this.manager.query(CARD_SQL, [id])) as ProductCardRow[];
    if (!row) return null;
    // bigint columns and sums arrive as strings; these values are far below 2^53.
    return {
      id: Number(row.id),
      title: row.name,
      description: row.description,
      price_cents: Number(row.price_cents),
      stock: row.stock,
      in_stock: row.stock > 0,
      sales: {
        units_sold: row.units_sold,
        orders: row.orders,
        buyers: row.buyers,
        revenue_cents: Number(row.revenue_cents),
        units_sold_30d: row.units_sold_30d,
        last_ordered_at: row.last_ordered_at?.toISOString() ?? null,
      },
      bought_together: row.bought_together,
    };
  }

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
