// The global authentication guard: every HTTP route needs a valid access token
// (Authorization: Bearer <JWT>), except the ones marked @Public().
//
// Any failure throws 401 (UnauthorizedException), never returns false: Nest turns
// false into 403 Forbidden, and a client that gets 403 for "no token" or "expired
// token" never tries to refresh. 403 is for "authenticated, but not allowed".
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { decodeProtectedHeader } from 'jose';
import { errorText, warnOnce } from '../redis/warn-once.js';
import type { AuthenticatedRequest } from './current-user.decorator.js';
import { TokenDenylist } from './denylist.js';
import { IS_PUBLIC } from './public.decorator.js';
import { type AuthUser, verifyAccessToken, type VerificationKeys } from './tokens.js';

export const VERIFICATION_KEYS = Symbol('VERIFICATION_KEYS');

// What a refused request is told to wait while the denylist can't be checked, in
// seconds (the Retry-After header).
export const DENYLIST_DOWN_RETRY_AFTER_SECONDS = 1;

const { warn: warnDenylistDown, ok: denylistUp } = warnOnce('auth');

@Injectable()
export class AccessTokenGuard implements CanActivate {
  private readonly logger = new Logger(AccessTokenGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(VERIFICATION_KEYS) private readonly keys: VerificationKeys,
    private readonly denylist: TokenDenylist,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // HTTP only. The Socket.IO gateway (HW#18) authenticates its own handshake with
    // the same verifyAccessToken (src/realtime/orders.gateway.ts).
    if (context.getType() !== 'http') return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    // RFC 6750: no token → just "Bearer", no error code; a token that was sent and
    // rejected → error="invalid_token". The scheme name is case-insensitive (RFC 9110).
    const token = /^Bearer +([A-Za-z0-9._~+/=-]+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!token) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException('An access token is required.');
    }

    let user: AuthUser;
    try {
      user = await verifyAccessToken(token, this.keys);
    } catch (error) {
      // jose's error code and the kid: enough to debug, and never the token.
      this.logger.warn(`access token rejected: ${(error as { code?: string }).code ?? 'ERR_UNKNOWN'} kid=${kidOf(token)}`);
      throw invalidToken(response);
    }

    // After the signature: revoked before its exp (logout, a detected reuse)?
    // Fail closed: when Redis can't answer, a revoked token can't be told from a
    // valid one, so nobody passes (OWASP 2025 A10: failing open is the weakness).
    // 503, not 401: the token isn't bad, the check is unavailable, and a 401 would
    // send every client to refresh and log in again during the outage.
    let denied: boolean;
    try {
      denied = await this.denylist.isDenied(user);
      denylistUp();
    } catch (error) {
      warnDenylistDown(`denylist check failed (${errorText(error)}): protected routes answer 503`);
      response.setHeader('Retry-After', String(DENYLIST_DOWN_RETRY_AFTER_SECONDS));
      throw new ServiceUnavailableException('Authentication is temporarily unavailable, try again shortly.');
    }
    if (denied) {
      // The jti is fine to log; the token isn't.
      this.logger.warn(`access token denylisted: jti=${user.jti} sid=${user.sid}`);
      throw invalidToken(response);
    }

    request.user = user;
    return true;
  }
}

const invalidToken = (response: Response) => {
  response.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
  return new UnauthorizedException('The access token is invalid or expired.');
};

// The header's kid, unverified, for the log line only.
function kidOf(token: string): string {
  try {
    return String(decodeProtectedHeader(token).kid ?? '(none)');
  } catch {
    return '(unreadable)';
  }
}
