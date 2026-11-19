// A sliding-window rate limit in Redis: one sorted set per client, one member per
// allowed request, scored by the time it was allowed. A request is allowed while
// fewer than `limit` members are younger than the window. Shared by every app
// instance, so the limit is the same however many instances run.
//
// Redis errors are thrown, not swallowed: the caller decides (the guard fails open).
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export const RATE_LIMIT: RateLimitRule = { limit: 5, windowMs: 10_000 };

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

// One script, so "count" and "add" can't be split by another instance's request:
// with ZCARD and ZADD as separate calls, concurrent requests all see the same count
// and all pass. The clock is Redis's own (TIME), so app instances whose clocks
// disagree still share one window.
//
// KEYS[1] the client's key. ARGV: window (ms), limit, a unique member.
// Returns {1, 0} when allowed, {0, ms until the oldest entry leaves the window}.
const SLIDING_WINDOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, 0}
end

local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, tonumber(oldest[2]) + window - now}
`;

export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly rule: RateLimitRule = RATE_LIMIT,
  ) {}

  // A refused request isn't recorded, so a client that keeps retrying while
  // limited gets through again as soon as its oldest request leaves the window.
  async hit(key: string): Promise<RateLimitResult> {
    // The member must be unique: two requests with the same member (e.g. the same
    // millisecond as a bare timestamp) would collapse into one entry, and the
    // limit would leak. The score carries the time.
    const [allowed, retryAfterMs] = (await this.redis.eval(
      SLIDING_WINDOW,
      1,
      key,
      this.rule.windowMs,
      this.rule.limit,
      randomUUID(),
    )) as [number, number];
    return allowed === 1 ? { allowed: true } : { allowed: false, retryAfterMs };
  }

  get limit(): number {
    return this.rule.limit;
  }

  get windowMs(): number {
    return this.rule.windowMs;
  }
}
