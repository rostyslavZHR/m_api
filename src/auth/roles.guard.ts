// The role level of authorization: a route marked @Roles(...) lets only those roles in.
// Global, registered after AccessTokenGuard (global guards run in registration order),
// so req.user is already verified when this runs; on a @Public() route there is no
// user, and nothing to check.
//
// The role comes from the access token, not from users: no query per request, but the
// token is a copy, up to 10 minutes stale (its lifetime). A demoted seller keeps
// writing products with the token they hold until it expires. A refresh doesn't cut
// that short: it reads the role from users again for the new token, but the old one
// isn't revoked. Logging out the user's sessions (the sid denylist) would.
//
// Throws ForbiddenException, never returns false: false is also a 403, but Nest's
// default one, without the detail the problem+json body carries.
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '../entities/index.js';
import type { AuthenticatedRequest } from './current-user.decorator.js';
import { ROLES } from './roles.decorator.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES, [context.getHandler(), context.getClass()]);
    if (!roles) return true;

    const { user } = context.switchToHttp().getRequest<Partial<AuthenticatedRequest>>();
    if (!user || !roles.includes(user.role)) {
      throw new ForbiddenException(`This needs one of the roles: ${roles.join(', ')}.`);
    }
    return true;
  }
}
