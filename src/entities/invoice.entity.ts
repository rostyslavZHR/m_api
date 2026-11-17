import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
} from 'typeorm';
import { OrderEntity } from './order.entity.js';

// The invoicing consumer's effect: one invoice per order. Written only by the
// consumer, in the same transaction as its processed_messages row
// (src/consumer/invoices.ts).
@Entity('invoices')
// One invoice per order: the natural key, enforced by the database. Level 1 of the
// consumer's idempotency: it protects the effect even when the processed_messages
// row is gone (cleaned up) or a different event arrives for the same order.
// INSERT … ON CONFLICT (order_id) DO NOTHING relies on it; named so errors are readable.
@Unique('invoices_order_id_key', ['orderId'])
export class InvoiceEntity {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
  })
  id: string;

  // order_id declared twice, as in OrderEventEntity: the column for the raw id,
  // the relation for the FK. An event for an order that doesn't exist fails with
  // 23503, which the consumer treats as poison.
  @Column('bigint', { name: 'order_id' })
  orderId: string;

  @ManyToOne(() => OrderEntity, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'order_id' })
  order: Relation<OrderEntity>;

  // Copied from the event, in integer minor units like every money column.
  @Column('bigint', { name: 'total_cents' })
  totalCents: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
