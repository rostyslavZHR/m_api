import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Column,
  type Relation,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { OrderEntity, type OrderStatus } from './order.entity.js';

@Entity('order_events')
@Index('order_events_order_id_idx', ['order', 'id'])
export class OrderEventEntity {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
  })
  id: string; // bigint → string in pg; also the SSE event id

  @ManyToOne(() => OrderEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'order_id' })
  order: Relation<OrderEntity>;

  // null only for the creation event: an order created by checkout has no previous status.
  @Column('text', { name: 'from_status', nullable: true })
  fromStatus: OrderStatus | null;

  @Column('text', { name: 'to_status' })
  toStatus: OrderStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
