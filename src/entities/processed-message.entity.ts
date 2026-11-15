import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

// The consumer side's dedup record: "this consumer has processed this message".
// A consumer inserts its row in the same transaction as its effect; a redelivered
// message hits the primary key (23505) and the effect is skipped.
//
// The key is (message_id, consumer), not message_id alone: several consumers
// (invoicing, inventory, …) may each process the same event once.
@Entity('processed_messages')
export class ProcessedMessageEntity {
  // The event's id: the same value as outbox.id.
  @PrimaryColumn('uuid', { name: 'message_id' })
  messageId: string;

  // Which consumer processed it, e.g. 'inventory'.
  @PrimaryColumn('text')
  consumer: string;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt: Date;
}
