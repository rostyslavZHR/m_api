import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { OrderEntity } from './order.entity.js';
import { UserEntity } from './user.entity.js';

// Idempotency-Key at the API edge (level 3): one row per (user, key), written as the
// first statement of the checkout transaction and committed with the order it
// created. A repeated key finds the row and gets the stored order back instead of a
// second one. Replaces the in-memory Map, which a restart (or a second instance)
// forgot. Rows older than 24 h are deleted (npm run idempotency:cleanup).
@Entity('idempotency_keys')
export class IdempotencyKeyEntity {
  // Scoped per user: the same key from two users is two keys, so user B can never
  // receive user A's order by guessing (or reusing) A's key.
  @PrimaryColumn('bigint', { name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: Relation<UserEntity>;

  // The client's Idempotency-Key header: a uuid (the OpenAPI spec requires one).
  @PrimaryColumn('uuid')
  key: string;

  // sha256 of the canonical request body. Only detects misuse (the same key with a
  // different body → 422); it's never the key itself: two identical orders placed
  // on purpose must stay two orders.
  @Column('text')
  fingerprint: string;

  // The order this key created. NULL only inside the transaction that claims the
  // key, between the key insert and the order insert; never visible committed.
  @Column('bigint', { name: 'order_id', nullable: true })
  orderId: string | null;

  @ManyToOne(() => OrderEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'order_id' })
  order: Relation<OrderEntity> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
