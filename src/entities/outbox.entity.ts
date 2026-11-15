import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

// The transactional outbox: an event is written here in the same transaction as the
// change it describes, and a relay publishes it to the broker later. So an event
// exists if and only if its change committed.
//
// No foreign key to orders: the outbox is a log of events for any aggregate type,
// and a FK would also block deleting an order that already has history.
//
// Snake_case columns, like every other table. Debezium's Outbox Event Router expects
// aggregatetype / aggregateid by default; a move to CDC would set
// route.by.field=aggregate_type and table.field.event.key=aggregate_id.
@Entity('outbox')
// The relay's query, exactly: WHERE published_at IS NULL ORDER BY created_at, id.
// Partial, so published rows drop out and the index stays as small as the backlog.
@Index('outbox_unpublished_idx', ['createdAt', 'id'], {
  where: '"published_at" IS NULL',
})
export class OutboxEntity {
  // The event's id: generated in code (randomUUID) before the insert, so the caller
  // knows it, and it travels with the message as the id consumers deduplicate by.
  // A uuid says nothing about how many orders exist.
  @PrimaryColumn('uuid')
  id: string;

  // What kind of thing changed, e.g. 'order'.
  @Column('text', { name: 'aggregate_type' })
  aggregateType: string;

  // Which one: the order's id. Text, so any id type fits.
  @Column('text', { name: 'aggregate_id' })
  aggregateId: string;

  // The event type, the same string as its routing key: 'order.placed'. The relay
  // publishes with it as the key.
  @Column('text')
  type: string;

  // The event contract, as published.
  @Column('jsonb')
  payload: object;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  // NULL = not sent yet. Set by the relay once the broker confirmed the message.
  @Column('timestamptz', { name: 'published_at', nullable: true })
  publishedAt: Date | null;

  // How many times the relay has tried to publish it.
  @Column('integer', { default: 0 })
  attempts: number;
}
