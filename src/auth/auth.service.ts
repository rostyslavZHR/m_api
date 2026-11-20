import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiEnv } from '../config/env.schema.js';
import { UsersRepository } from '../users/users.repository.js';
import { dummyPasswordHash, verifyPassword } from './password.js';
import { RefreshTokensRepository } from './refresh-tokens.repository.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashRefreshToken,
  newRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  signAccessToken,
} from './tokens.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  // The access token's lifetime, in seconds.
  expiresIn: number;
}

// One answer for every bad credential: an unknown email and a wrong password must
// look the same, or the endpoint tells an attacker which emails are registered.
const BAD_CREDENTIALS = 'Invalid email or password.';

// At most this many password checks at once, in this process. Each Argon2id hash
// takes 64 MiB and a libuv thread-pool thread (4 by default, shared with fs,
// dns.lookup and crypto): without a cap, a burst of logins fills the pool and stalls
// all of those, and a larger pool (UV_THREADPOOL_SIZE) would make memory unbounded.
// 2 keeps hashing at ~128 MiB and leaves half the pool free.
export const MAX_CONCURRENT_PASSWORD_CHECKS = 2;
// What a refused login is told to wait, in seconds (the Retry-After header).
export const LOGIN_BUSY_RETRY_AFTER_SECONDS = 1;

// The cap is full: answered 503 with Retry-After, at once, instead of queueing.
export class LoginBusyException extends ServiceUnavailableException {
  constructor() {
    super('Too many logins at once, try again shortly.');
  }
}

@Injectable()
export class AuthService implements OnModuleInit {
  private passwordChecks = 0;

  constructor(
    private readonly users: UsersRepository,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly config: ConfigService<ApiEnv, true>,
  ) {}

  // The dummy hash for unknown emails, computed before the first request: computed
  // lazily, the first unknown email would take two Argon2 runs and stand out.
  async onModuleInit(): Promise<void> {
    await dummyPasswordHash();
  }

  async login(email: string, password: string, now = new Date()): Promise<TokenPair> {
    // Before any work: a full cap refuses the login at once, for a known and an
    // unknown email alike (so it reveals nothing about the account either).
    if (this.passwordChecks >= MAX_CONCURRENT_PASSWORD_CHECKS) throw new LoginBusyException();
    this.passwordChecks++;
    let user: Awaited<ReturnType<UsersRepository['findForLogin']>>;
    let ok = false;
    try {
      user = await this.users.findForLogin(email);
      // No user (or one without a password): still run a full Argon2 verification,
      // against a dummy hash, so the response takes as long as a wrong password.
      if (user?.passwordHash) {
        ok = await verifyPassword(password, user.passwordHash);
      } else {
        await verifyPassword(password, await dummyPasswordHash());
      }
    } finally {
      this.passwordChecks--;
    }
    if (!user || !ok) throw new UnauthorizedException(BAD_CREDENTIALS);

    const accessToken = await signAccessToken(
      { privateKey: this.config.get('JWT_PRIVATE_KEY', { infer: true }), kid: this.config.get('JWT_KID', { infer: true }) },
      user,
      now,
    );

    // A new family per login; the raw token goes back once, in this response, and is
    // never stored or logged.
    const refreshToken = newRefreshToken();
    await this.refreshTokens.insert({
      userId: user.id,
      tokenHash: hashRefreshToken(this.config.get('REFRESH_TOKEN_PEPPER', { infer: true }), refreshToken),
      familyId: randomUUID(),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    });

    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }
}
