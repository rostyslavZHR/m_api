import type { EntityManager } from 'typeorm';
import { RefreshTokenEntity } from '../entities/index.js';

export interface NewRefreshToken {
  userId: string;
  // The HMAC, never the token itself.
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

export type StoredRefreshToken = Pick<
  RefreshTokenEntity,
  'id' | 'userId' | 'familyId' | 'usedAt' | 'revokedAt' | 'expiresAt'
>;

// Takes an EntityManager, like the other repositories: inside a transaction, its
// queries run on the transaction's connection.
export class RefreshTokensRepository {
  constructor(private readonly manager: EntityManager) {}

  async insert(token: NewRefreshToken): Promise<void> {
    await this.manager.insert(RefreshTokenEntity, token);
  }

  // The row for a presented token, locked (FOR UPDATE) until the transaction ends: a
  // second refresh of the same token waits here, then sees used_at already set.
  // Without the lock, two parallel refreshes would both see it unused and both
  // rotate: two live branches of one family.
  findForUpdate(tokenHash: string): Promise<StoredRefreshToken | null> {
    return this.manager
      .createQueryBuilder(RefreshTokenEntity, 'token')
      .select(['token.id', 'token.userId', 'token.familyId', 'token.usedAt', 'token.revokedAt', 'token.expiresAt'])
      .where('token.tokenHash = :tokenHash', { tokenHash })
      .setLock('pessimistic_write')
      .getOne();
  }

  async markUsed(id: string, now: Date): Promise<void> {
    await this.manager.update(RefreshTokenEntity, { id }, { usedAt: now });
  }

  // Every token of the family that isn't revoked yet; how many.
  async revokeFamily(familyId: string, now: Date): Promise<number> {
    const result = await this.manager
      .createQueryBuilder()
      .update(RefreshTokenEntity)
      .set({ revokedAt: now })
      .where('family_id = :familyId AND revoked_at IS NULL', { familyId })
      .execute();
    return result.affected ?? 0;
  }
}
