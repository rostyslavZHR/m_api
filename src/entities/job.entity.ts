import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { OrderEntity } from './order.entity.js';

// One list drives both the TS type and the CHECK constraint, so they can't drift.
export const JOB_STATUSES = ['new', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const statusList = JOB_STATUSES.map((status) => `'${status}'`).join(', ');

@Entity('jobs')
@Check('jobs_status_check', `status IN (${statusList})`)
// Partial: workers only ever look for new jobs, so the index holds just those.
@Index('jobs_pending_idx', ['id'], { where: `status = 'new'` })
export class JobEntity {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id: string;

  @Column('text')
  type: string;

  // Optional: a job may concern an order. It goes with its order.
  @ManyToOne(() => OrderEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'order_id' })
  order: Relation<OrderEntity> | null;

  @Column('text', { default: 'new' })
  status: JobStatus;

  // Which worker claimed the job; null until claimed.
  @Column('text', { nullable: true })
  worker: string | null;

  // The brief's counter: how many times the job's work was actually applied.
  @Column('integer', { default: 0 })
  processed: number;

  @Column('integer', { default: 0 })
  attempts: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
