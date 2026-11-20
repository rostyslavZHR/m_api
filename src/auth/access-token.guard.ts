// The global authentication guard: every HTTP route needs a valid access token
// (Authorization: Bearer <JWT>), except the ones marked @Public().
//
// Any failure throws 401 (UnauthorizedException), never returns false: Nest turns
// false into 403 Forbidden, and a client that gets 403 for "no token" or "expired
// token" never tries to refresh. 403 is for "authenticated, but not allowed".
import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { decodeProtectedHeader } from 'jose';
import type { AuthenticatedRequest } from './current-user.decorator.js';
import { IS_PUBLIC } from './public.decorator.js';
import { verifyAccessToken, type VerificationKeys } from './tokens.js';

export const VERIFICATION_KEYS = Symbol('VERIFICATION_KEYS');

@Injectable()
export class AccessTokenGuard implements CanActivate {
  private readonly logger = new Logger(AccessTokenGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(VERIFICATION_KEYS) private readonly keys: VerificationKeys,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // HTTP only: the Socket.IO gateway (HW#18) isn't covered by this guard.
    if (context.getType() !== 'http') return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    // RFC 6750: no token → just "Bearer", no error code; a token that was sent and
    // rejected → error="invalid_token".
    const token = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!token) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException('An access token is required.');
    }

    try {
      request.user = await verifyAccessToken(token, this.keys);
      return true;
    } catch (error) {
      // jose's error code and the kid: enough to debug, and never the token.
      this.logger.warn(`access token rejected: ${(error as { code?: string }).code ?? 'ERR_UNKNOWN'} kid=${kidOf(token)}`);
      response.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      throw new UnauthorizedException('The access token is invalid or expired.');
    }
  }
}

// The header's kid, unverified, for the log line only.
function kidOf(token: string): string {
  try {
    return String(decodeProtectedHeader(token).kid ?? '(none)');
  } catch {
    return '(unreadable)';
  }
}
