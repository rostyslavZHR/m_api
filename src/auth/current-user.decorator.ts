import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from './tokens.js';

// The request with what AccessTokenGuard puts on it.
export type AuthenticatedRequest = Request & { user: AuthUser };

// @CurrentUser() user: AuthUser, in a handler of a protected route (on a @Public()
// route there is no user).
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
