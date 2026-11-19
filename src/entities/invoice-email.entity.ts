import { CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryColumn, type Relation } from 'typeorm';
import { OrderEntity } from './order.entity.js';

// The invoice-email job's effect (src/jobs/handlers.ts): one row per order whose
// invoice email went out. The primary key is the idempotency key: the handler
// inserts with ON CONFLICT (order_id) DO NOTHING, so a job that runs twice (a
// stalled job, a duplicate event) sends one email.
@Entity('invoice_emails')
export class InvoiceEmailEntity {
  @PrimaryColumn('bigint', { name: 'order_id' })
  orderId: string;

  @OneToOne(() => OrderEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Relation<OrderEntity>;

  @CreateDateColumn({ name: 'sent_at', type: 'timestamptz' })
  sentAt: Date;
}
