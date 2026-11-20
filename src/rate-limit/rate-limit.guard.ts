// The rate limit as a guard on the routes that use it: @UseGuards(RateLimitGuard).
// One counter per route per client. Over the limit: 429 (problem+json, through
// ProblemExceptionFilter) with Retry-After in whole seconds, at least 1.
//
// Fail open: when Redis doesn't answer, the request goes through, logged once. The
// limit protects the service; an outage of the limiter mustn't take it down.
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/current-user.decorator.js';
import { errorText, warnOnce } from '../redis/warn-once.js';
import { sessionOf } from '../sessions/session.middleware.js';
import { RateLimiter } from './rate-limiter.js';

const { warn, ok } = warnOnce('rate-limit');

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const res = http.getResponse<Response>();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    const key = `rl:${route}:${clientOf(http.getRequest<Partial<AuthenticatedRequest>>(), res)}`;

    let result;
    try {
      result = await this.limiter.hit(key);
      ok();
    } catch (error) {
      warn(`check failed (${errorText(error)}), requests are let through`);
      return true;
    }
    if (result.allowed) return true;

    const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(seconds));
    throw new HttpException(
      `Rate limit exceeded: ${this.limiter.limit} requests per ${this.limiter.windowMs / 1000} s. Retry after ${seconds} s.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

// Who the client is, most reliable first: the access token's user (set by the global
// AccessTokenGuard, which runs before this route guard; a client can't pick it), then
// the cookie session's user (SessionMiddleware runs before guards), otherwise the IP.
// The same "user:<id>" either way, so one user has one counter per route. req.ip is the socket's address: 'trust proxy' is off
// because nothing sits in front of the app, so a client can't pick its own IP with
// X-Forwarded-For. Behind a proxy, set 'trust proxy' to that proxy's hop count, or
// every client shares the proxy's limit.
function clientOf(req: Partial<AuthenticatedRequest>, res: Response): string {
  if (req.user) return `user:${req.user.id}`;
  const session = sessionOf(res);
  if (session.state === 'active') return `user:${session.data.userId}`;
  return `ip:${req.ip ?? 'unknown'}`;
}
