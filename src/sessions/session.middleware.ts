// Runs on every request. With a session cookie: load the session and restart its
// idle TTL (one GETEX), and leave the outcome in res.locals.session. Without one:
// nothing, and in particular no new session: anonymous requests (bots, health
// checks) never create keys.
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { parseCookie } from 'cookie';
import type { NextFunction, Request, Response } from 'express';
import { errorText, warnOnce } from '../redis/warn-once.js';
import { type SessionData, SessionStore } from './session.store.js';

export const SESSION_COOKIE = 'sid';

export type SessionState =
  | { state: 'none' } // no cookie
  | { state: 'expired' } // a cookie, but no live session behind it
  | { state: 'unavailable' } // Redis didn't answer: unknown, not logged out
  | { state: 'active'; id: string; data: SessionData };

export const sessionOf = (res: Response): SessionState =>
  (res.locals.session as SessionState | undefined) ?? { state: 'none' };

const { warn, ok } = warnOnce('sessions');

@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(private readonly store: SessionStore) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const id = parseCookie(req.headers.cookie ?? '')[SESSION_COOKIE];
    if (!id) {
      res.locals.session = { state: 'none' } satisfies SessionState;
      return next();
    }
    try {
      const data = await this.store.touch(id);
      ok();
      res.locals.session = (data ? { state: 'active', id, data } : { state: 'expired' }) satisfies SessionState;
    } catch (error) {
      warn(`session read failed (${errorText(error)})`);
      res.locals.session = { state: 'unavailable' } satisfies SessionState;
    }
    next();
  }
}
