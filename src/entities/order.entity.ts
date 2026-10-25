import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { UserEntity } from './user.entity.js';
import { OrderItemEntity } from './order-item.entity.js';

// The source of truth for statuses: the TS type and the entity's @Check come from it.
// Two copies are hand-written: the CHECK a migration created (TypeORM compares CHECKs by
// name, so migration:generate won't notice a new status) and the spec's OrderStatus enum.
// test/integration/order-statuses.spec.ts fails if either one drifts from this list.
export const ORDER_STATUSES = [
  'paid',
  'processing',
  'shipped',
  'out_for_delivery',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  paid: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
};

const statusList = ORDER_STATUSES.map((status) => `'${status}'`).join(', ');

@Entity('orders')
@Check('orders_status_check', `status IN (${statusList})`)
@Check('orders_total_cents_check', 'total_cents >= 0')
// Property names, not column names: TypeORM resolves user to user_id.
@Index('orders_user_created_idx', ['user', 'createdAt'])
@Index('orders_paid_created_idx', ['createdAt'], { where: `status = 'paid'` })
export class OrderEntity {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
  })
  id: string;

  @ManyToOne(() => UserEntity, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: Relation<UserEntity>;

  @Column('text', { default: 'paid' })
  status: OrderStatus;

  // Stored, not summed on read: it's a fact about the transaction (HW#12 decision).
  // Integer minor units, like every money column.
  @Column('bigint', { name: 'total_cents' })
  totalCents: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => OrderItemEntity, (item) => item.order, { cascade: true })
  items: Relation<OrderItemEntity[]>;
}
