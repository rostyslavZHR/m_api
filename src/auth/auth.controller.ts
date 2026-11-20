import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService, LOGIN_BUSY_RETRY_AFTER_SECONDS, LoginBusyException, type TokenPair } from './auth.service.js';
import { CurrentUser } from './current-user.decorator.js';
import { Public } from './public.decorator.js';
import type { AuthUser } from './tokens.js';

// The request body (a password) is never logged: nothing here or in the app's
// middleware prints request bodies, and the error filter writes only the message.
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Public: this is how a client gets a token in the first place.
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { email: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPair> {
    try {
      return await this.auth.login(body.email, body.password);
    } catch (error) {
      // The 503 of a full password-check cap says when to come back.
      if (error instanceof LoginBusyException) res.setHeader('Retry-After', String(LOGIN_BUSY_RETRY_AFTER_SECONDS));
      throw error;
    }
  }

  // Who the token says you are: what the guard put on req.user.
  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
