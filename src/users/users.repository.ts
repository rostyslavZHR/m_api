import type { EntityManager } from 'typeorm';
import { UserEntity } from '../entities/index.js';

// Takes an EntityManager, like the other repositories.
export class UsersRepository {
  constructor(private readonly manager: EntityManager) {}

  exists(id: string): Promise<boolean> {
    return this.manager.existsBy(UserEntity, { id });
  }
}
