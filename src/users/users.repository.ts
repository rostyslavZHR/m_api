import type { EntityManager } from 'typeorm';
import { UserEntity, type UserRole } from '../entities/index.js';

export interface LoginUser {
  id: string;
  role: UserRole;
  passwordHash: string | null;
}

// Takes an EntityManager, like the other repositories.
export class UsersRepository {
  constructor(private readonly manager: EntityManager) {}

  exists(id: string): Promise<boolean> {
    return this.manager.existsBy(UserEntity, { id });
  }

  // The role as it is now (the token's role claim is only a cache of it). null when
  // the user is gone.
  async findRole(id: string): Promise<UserRole | null> {
    const user = await this.manager.findOne(UserEntity, { where: { id }, select: { id: true, role: true } });
    return user?.role ?? null;
  }

  // The one read that includes the password hash (not selected by default). By
  // the exact email: the unique index users_email_key serves it.
  findForLogin(email: string): Promise<LoginUser | null> {
    return this.manager
      .createQueryBuilder(UserEntity, 'user')
      .select(['user.id', 'user.role'])
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .getOne();
  }
}
