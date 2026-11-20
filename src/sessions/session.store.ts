// Sessions as our own token state in Redis: sess:<id> holds a JSON string, read and
// renewed in one command (GETEX … EX), so an active user's idle TTL restarts on
// every request. No process memory anywhere: a restart or a second instance sees
// the same sessions. Redis errors are thrown, not swallowed: the caller decides
// (503, never a silent logout).
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface SessionData {
  userId: number;
  // ISO time of creation: the absolute lifetime is measured from it.
  createdAt: string;
}

export interface SessionTtl {
  // Logged out after this long without a request.
  idleSeconds: number;
  // Logged out after this long whatever the activity: a rolling TTL alone would
  // keep an always-active session (or a stolen cookie in a script) alive forever.
  absoluteSeconds: number;
}

export const SESSION_TTL: SessionTtl = { idleSeconds: 30 * 60, absoluteSeconds: 7 * 24 * 60 * 60 };

const key = (id: string) => `sess:${id}`;

// 32 random bytes, base64url: 43 characters, 256 bits, unguessable, so the id
// needs no signature. Anything else in the cookie never reaches Redis.
const newId = () => randomBytes(32).toString('base64url');
const ID_FORMAT = /^[A-Za-z0-9_-]{43}$/;

// The stored JSON, or null when it isn't a session this code wrote.
function parse(raw: string): SessionData | null {
  try {
    const data = JSON.parse(raw) as Partial<SessionData>;
    if (typeof data.userId !== 'number' || Number.isNaN(Date.parse(data.createdAt ?? ''))) return null;
    return data as SessionData;
  } catch {
    return null;
  }
}

export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttl: SessionTtl = SESSION_TTL,
  ) {}

  async create(userId: number, now = new Date()): Promise<{ id: string; data: SessionData }> {
    const id = newId();
    const data: SessionData = { userId, createdAt: now.toISOString() };
    // EX always, and NX: a new id never overwrites an existing session.
    const stored = await this.redis.set(key(id), JSON.stringify(data), 'EX', this.ttl.idleSeconds, 'NX');
    if (stored !== 'OK') throw new Error('session id collision');
    return { id, data };
  }

  // Loads the session and restarts its idle TTL in the same command. null when
  // the id is malformed, unknown, expired, past its absolute lifetime, or its value
  // is unreadable (deleted then, like an expired one: otherwise that cookie would
  // fail on every request).
  async touch(id: string, now = new Date()): Promise<SessionData | null> {
    if (!ID_FORMAT.test(id)) return null;
    const raw = await this.redis.getex(key(id), 'EX', this.ttl.idleSeconds);
    if (raw === null) return null;

    const data = parse(raw);
    if (!data || now.getTime() - Date.parse(data.createdAt) > this.ttl.absoluteSeconds * 1000) {
      await this.redis.del(key(id));
      return null;
    }
    return data;
  }

  async destroy(id: string): Promise<void> {
    if (ID_FORMAT.test(id)) await this.redis.del(key(id));
  }

  get idleSeconds(): number {
    return this.ttl.idleSeconds;
  }

  get absoluteSeconds(): number {
    return this.ttl.absoluteSeconds;
  }
}
