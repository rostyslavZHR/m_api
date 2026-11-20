import { Check, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

// The source of truth for roles: the TS type and the CHECK come from this list.
export const USER_ROLES = ['customer', 'seller', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

const roleList = USER_ROLES.map((role) => `'${role}'`).join(', ');

// @Unique at class level rather than { unique: true } on the column, so the
// constraint keeps Postgres's name from HW#12 instead of a generated UQ_<hash>.
@Entity('users')
@Unique('users_email_key', ['email'])
// Backstop: whatever the code does, a balance can't go negative.
@Check('users_balance_cents_check', 'balance_cents >= 0')
@Check('users_role_check', `role IN (${roleList})`)
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

  // An Argon2id hash in PHC format (src/auth/password.ts), never the password. NULL for
  // users created before HW#24 (and the test builders): they can't log in. Not
  // selected by default, so no ordinary read carries it.
  @Column('text', { name: 'password_hash', nullable: true, select: false })
  passwordHash: string | null;

  @Column('text', { default: 'customer' })
  role: UserRole;
}
