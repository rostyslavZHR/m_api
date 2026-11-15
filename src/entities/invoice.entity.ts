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

// The invoicing consumer's effect: one row per order.placed event. Written only by
// the consumer, with INSERT … ON CONFLICT (event_id) DO NOTHING, so a redelivered
// event inserts nothing (src/consumer/invoices.ts).
@Entity('invoices')
// At most one invoice per event, enforced by the database. ON CONFLICT (event_id)
// relies on this constraint; it's named so error messages are readable.
@Unique('invoices_event_id_key', ['eventId'])
export class InvoiceEntity {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
  })
  id: string;

  // The event's id (the order's creation row in order_events): the dedup key.
  @Column('bigint', { name: 'event_id' })
  eventId: string;

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
