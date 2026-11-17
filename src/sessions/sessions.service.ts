import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { errorText, warnOnce } from '../redis/warn-once.js';
import { UsersRepository } from '../users/users.repository.js';
import type { SessionState } from './session.middleware.js';
import { type SessionData, SessionStore } from './session.store.js';

const { warn, ok } = warnOnce('sessions');

@Injectable()
export class SessionsService {
  constructor(
    private readonly store: SessionStore,
    private readonly users: UsersRepository,
  ) {}

  // A new id at every login; the session already on the request, if any, ends
  // (no session fixation). Redis errors become a 503: the store is unavailable,
  // nobody was logged out.
  async login(userId: number, current: SessionState): Promise<{ id: string; data: SessionData }> {
    if (!(await this.users.exists(String(userId)))) {
      throw new NotFoundException(`User ${userId} not found.`);
    }
    try {
      if (current.state === 'active') await this.store.destroy(current.id);
      const created = await this.store.create(userId);
      ok();
      return created;
    } catch (error) {
      warn(`session write failed (${errorText(error)})`);
      throw new ServiceUnavailableException('Sessions are unavailable, try again shortly.');
    }
  }

  get idleSeconds(): number {
    return this.store.idleSeconds;
  }

  get absoluteSeconds(): number {
    return this.store.absoluteSeconds;
  }
}
