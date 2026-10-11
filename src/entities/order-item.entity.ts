import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import { OrderEntity } from './order.entity.js';
import { ProductEntity } from './product.entity.js';

// Relation properties are typed Relation<…>: with emitDecoratorMetadata a plain
// class type compiles to a reference that runs when the class is defined, and
// the entities import each other — so one of them would still be uninitialised.
// Relation<T> is just T, but emits Object instead.
//
// Composite key: each key column is declared twice — @PrimaryColumn makes it
// part of the key, @ManyToOne + @JoinColumn with the same name makes it the
// foreign key. Both map to one physical column.
@Entity('order_items')
@Check('order_items_quantity_check', 'quantity > 0')
@Check('order_items_unit_price_cents_check', 'unit_price_cents >= 0')
// The FK index from the HW#12 review: the primary key covers order_id as its
// left column, but product_id needs its own for DELETE on products.
@Index('order_items_product_id_idx', ['productId'])
export class OrderItemEntity {
  @PrimaryColumn('bigint', { name: 'order_id' })
  orderId: string;

  @PrimaryColumn('bigint', { name: 'product_id' })
  productId: string;

  @ManyToOne(() => OrderEntity, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Relation<OrderEntity>;

  @ManyToOne(() => ProductEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product: Relation<ProductEntity>;

  @Column('integer')
  quantity: number;

  // Price and name are snapshotted on the line, so old orders keep what was paid.
  @Column('bigint', { name: 'unit_price_cents' })
  unitPriceCents: string;

  @Column('text', { name: 'product_name' })
  productName: string;
}
