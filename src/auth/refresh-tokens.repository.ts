import type { EntityManager } from 'typeorm';
import { RefreshTokenEntity } from '../entities/index.js';

export interface NewRefreshToken {
  userId: string;
  // The HMAC, never the token itself.
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

// Takes an EntityManager, like the other repositories.
export class RefreshTokensRepository {
  constructor(private readonly manager: EntityManager) {}

  async insert(token: NewRefreshToken): Promise<void> {
    await this.manager.insert(RefreshTokenEntity, token);
  }
}
