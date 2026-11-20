import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { ApiEnv } from '../config/env.schema.js';
import type { UserRole } from '../entities/index.js';
import { UsersRepository } from '../users/users.repository.js';
import { dummyPasswordHash, verifyPassword } from './password.js';
import { TokenDenylist } from './denylist.js';
import { RefreshTokensRepository } from './refresh-tokens.repository.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  type AuthUser,
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

// One answer for every refresh failure (unknown, expired, revoked, reused): a client
// SDK reacts to 401 by sending the user to log in.
const BAD_REFRESH = 'The refresh token is invalid or expired.';

type RefreshOutcome =
  | { kind: 'rejected' }
  | { kind: 'reused'; familyId: string; userId: string; revoked: number }
  | { kind: 'rotated'; userId: string; role: UserRole; familyId: string; refreshToken: string };

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
  private readonly logger = new Logger(AuthService.name);
  private passwordChecks = 0;

  constructor(
    private readonly users: UsersRepository,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly config: ConfigService<ApiEnv, true>,
    private readonly dataSource: DataSource,
    private readonly denylist: TokenDenylist,
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

    // A new family per login. The access token carries it as sid, so a logout or a
    // detected reuse can cut off its access tokens too.
    const familyId = randomUUID();
    const accessToken = await signAccessToken(this.signingKey(), user, familyId, now);

    // The raw refresh token goes back once, in this response, and is never stored or
    // logged.
    const refreshToken = newRefreshToken();
    await this.refreshTokens.insert({
      userId: user.id,
      tokenHash: hashRefreshToken(this.config.get('REFRESH_TOKEN_PEPPER', { infer: true }), refreshToken),
      familyId,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    });

    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  // Refresh-token rotation with reuse detection (#168), in one transaction:
  //   the row, locked → unknown, revoked or expired: 401;
  //   already used → someone replays an old token (a thief, or a client that
  //     refreshed twice): revoke the WHOLE family, the honest client's newer token
  //     too, and COMMIT that before answering 401: thrown inside the transaction, the
  //     401 would roll the revocation back and leave the thief refreshing;
  //   otherwise → mark it used, insert its successor in the same family, commit, and
  //     sign a new access token with the role as it is NOW in users (the role claim is
  //     a cache; this is where a demotion reaches the token).
  // The successor keeps the family's original expiry: a fixed maximum session from
  // the login, which refreshing can't extend.
  async refresh(presented: string, now = new Date()): Promise<TokenPair> {
    const pepper = this.config.get('REFRESH_TOKEN_PEPPER', { infer: true });
    const outcome = await this.dataSource.transaction(async (manager): Promise<RefreshOutcome> => {
      const tokens = new RefreshTokensRepository(manager);
      const row = await tokens.findForUpdate(hashRefreshToken(pepper, presented));
      if (!row || row.revokedAt || row.expiresAt <= now) return { kind: 'rejected' };
      if (row.usedAt) {
        const revoked = await tokens.revokeFamily(row.familyId, now);
        return { kind: 'reused', familyId: row.familyId, userId: row.userId, revoked };
      }

      const role = await new UsersRepository(manager).findRole(row.userId);
      if (!role) return { kind: 'rejected' };
      await tokens.markUsed(row.id, now);
      const refreshToken = newRefreshToken();
      await tokens.insert({
        userId: row.userId,
        tokenHash: hashRefreshToken(pepper, refreshToken),
        familyId: row.familyId,
        expiresAt: row.expiresAt,
      });
      return { kind: 'rotated', userId: row.userId, role, familyId: row.familyId, refreshToken };
    });

    // Committed by now, whatever the outcome.
    if (outcome.kind === 'reused') {
      // The family and the user, never the token.
      this.logger.warn(
        `refresh token reuse: family ${outcome.familyId} of user ${outcome.userId} revoked (${outcome.revoked} tokens)`,
      );
      // The family's access tokens too: one the attacker got from an earlier refresh
      // would otherwise work until its exp. Best effort: the answer is a 401 either
      // way, and the refresh tokens are already revoked.
      await this.denylist.denySession(outcome.familyId).catch((error: Error) =>
        this.logger.error(`family ${outcome.familyId}: access tokens not denylisted (${error.message}), they expire within ${ACCESS_TOKEN_TTL_SECONDS} s`),
      );
    }
    if (outcome.kind !== 'rotated') throw new UnauthorizedException(BAD_REFRESH);

    const accessToken = await signAccessToken(
      this.signingKey(),
      { id: outcome.userId, role: outcome.role },
      outcome.familyId,
      now,
    );
    return { accessToken, refreshToken: outcome.refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  // Logout, two actions, because the two tokens die differently:
  //   1. the refresh family, in Postgres: revoked_at on its live rows (a row is enough);
  //   2. the access token, in Redis: it's self-contained, so its jti goes on the
  //      denylist until its exp, and the family's sid for the access-token lifetime
  //      (any other access token of this login, e.g. one from before a refresh).
  // Two stores, so not atomic (a dual write): Postgres first, then Redis. If Redis
  // fails, the answer is 503, never a 204 for a half-done logout, and the client
  // retries: both writes are idempotent, and the access token still passes the guard
  // because its jti isn't denylisted yet. (The other order would break the retry: a
  // denylisted jti can't authenticate the second attempt.)
  async logout(user: AuthUser, now = new Date()): Promise<void> {
    const revoked = await this.refreshTokens.revokeFamily(user.sid, now);
    try {
      await this.denylist.denyToken(user.jti, user.exp, now);
      await this.denylist.denySession(user.sid);
    } catch (error) {
      this.logger.error(`logout of family ${user.sid}: refresh tokens revoked, denylist write failed (${(error as Error).message})`);
      throw new ServiceUnavailableException('Logout could not be completed, try again.');
    }
    this.logger.log(`logout: family ${user.sid} of user ${user.id} (${revoked} refresh tokens revoked, jti ${user.jti} denylisted)`);
  }

  private signingKey() {
    return { privateKey: this.config.get('JWT_PRIVATE_KEY', { infer: true }), kid: this.config.get('JWT_KID', { infer: true }) };
  }
}
