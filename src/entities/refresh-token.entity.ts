import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { UserEntity } from './user.entity.js';

// One row per refresh token ever issued. Only the token's HMAC is stored
// (src/auth/tokens.ts): a dump of this table holds no usable token.
@Entity('refresh_tokens')
// Every refresh looks its token up by hash: unique, and the lookup's index.
@Index('refresh_tokens_token_hash_key', ['tokenHash'], { unique: true })
// Reuse detection revokes a whole family at once (Phase D).
@Index('refresh_tokens_family_id_idx', ['familyId'])
// The FK's index: "every token of this user" (logout everywhere) and ON DELETE.
@Index('refresh_tokens_user_id_idx', ['userId'])
export class RefreshTokenEntity {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id: string;

  @Column('bigint', { name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: Relation<UserEntity>;

  // HMAC-SHA256(pepper, token), hex: deterministic, so a token can be found by it.
  @Column('text', { name: 'token_hash' })
  tokenHash: string;

  // Every token from one login shares it: a rotation keeps the family.
  @Column('uuid', { name: 'family_id' })
  familyId: string;

  // Set when the token is exchanged for a new one (Phase C/D).
  @Column('timestamptz', { name: 'used_at', nullable: true })
  usedAt: Date | null;

  // Set by logout, or when the family is revoked.
  @Column('timestamptz', { name: 'revoked_at', nullable: true })
  revokedAt: Date | null;

  @Column('timestamptz', { name: 'expires_at' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
