import { Check, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

// @Unique at class level rather than { unique: true } on the column, so the
// constraint keeps Postgres's name from HW#12 instead of a generated UQ_<hash>.
@Entity('users')
@Unique('users_email_key', ['email'])
// Backstop: whatever the code does, a balance can't go negative.
@Check('users_balance_cents_check', 'balance_cents >= 0')
export class UserEntity {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id: string;

  @Column('text')
  email: string;

  // Integer minor units (cents), like every money column. pg returns bigint as a string.
  @Column('bigint', { name: 'balance_cents', default: 0 })
  balanceCents: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
