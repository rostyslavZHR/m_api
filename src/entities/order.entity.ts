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

// One list drives both the TS type and the CHECK constraint, so they can't drift.
export const ORDER_STATUSES = ['new', 'paid', 'shipped', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const statusList = ORDER_STATUSES.map((status) => `'${status}'`).join(', ');

@Entity('orders')
@Check('orders_status_check', `status IN (${statusList})`)
@Check('orders_total_cents_check', 'total_cents >= 0')
// Property names, not column names: TypeORM resolves user to user_id.
@Index('orders_user_created_idx', ['user', 'createdAt'])
@Index('orders_new_created_idx', ['createdAt'], { where: `status = 'new'` })
export class OrderEntity {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id: string;

  @ManyToOne(() => UserEntity, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: Relation<UserEntity>;

  @Column('text', { default: 'new' })
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
