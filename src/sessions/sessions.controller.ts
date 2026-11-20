// A stand-in for login (real authentication is HW#24): POST /sessions starts a
// session for a user, GET /session reads it. The session id travels only in the
// cookie, never in a body.
import { Body, Controller, Get, HttpCode, Post, Res, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { SESSION_COOKIE, sessionOf } from './session.middleware.js';
import type { SessionData } from './session.store.js';
import { SessionsService } from './sessions.service.js';
import { Public } from '../auth/public.decorator.js';

// The Session schema in openapi/openapi.yaml.
interface SessionView {
  user_id: number;
  created_at: string;
  idle_ttl_seconds: number;
  expires_at: string;
}

// Public: HW#23's cookie-session stand-in has its own mechanism (the sid cookie), not
// the bearer token. Replaced by real login (/auth/login) in HW#24; never ship it.
@Public()
@Controller()
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  // httpOnly: page scripts can't read it. sameSite lax: not sent on cross-site
  // POSTs. secure in production: HTTPS only. Max-Age = the absolute lifetime;
  // the idle timeout is Redis's TTL, not the cookie's.
  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: this.sessions.absoluteSeconds * 1000,
    };
  }

  private view(data: SessionData): SessionView {
    return {
      user_id: data.userId,
      created_at: data.createdAt,
      idle_ttl_seconds: this.sessions.idleSeconds,
      expires_at: new Date(Date.parse(data.createdAt) + this.sessions.absoluteSeconds * 1000).toISOString(),
    };
  }

  @Post('sessions')
  @HttpCode(201)
  async create(@Body() body: { user_id: number }, @Res({ passthrough: true }) res: Response): Promise<SessionView> {
    const { id, data } = await this.sessions.login(body.user_id, sessionOf(res));
    res.cookie(SESSION_COOKIE, id, this.cookieOptions());
    return this.view(data);
  }

  @Get('session')
  read(@Res({ passthrough: true }) res: Response): SessionView {
    const session = sessionOf(res);
    switch (session.state) {
      case 'active':
        return this.view(session.data);
      case 'unavailable':
        throw new ServiceUnavailableException('Sessions are unavailable, try again shortly.');
      case 'expired':
        // The cookie points at nothing: drop it, so the browser stops sending it.
        res.clearCookie(SESSION_COOKIE, { ...this.cookieOptions(), maxAge: undefined });
        throw new UnauthorizedException('The session has expired.');
      case 'none':
        throw new UnauthorizedException('No session.');
    }
  }
}
