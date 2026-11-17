// Cache-aside: read Redis; on a miss, load from the database and SET with a TTL.
// The cache can only make a request faster, never fail it: a failed read is a
// miss, a failed write (timeout, OOM, Redis down) is logged and the loaded value
// is returned anyway.
import { randomInt } from 'node:crypto';
import type { Redis } from 'ioredis';
import { errorText, warnOnce } from './warn-once.js';

const { warn, ok: recovered } = warnOnce('cache');

export interface Ttl {
  baseSeconds: number;
  jitterSeconds: number;
}

// base + 0..jitter seconds, both ends included, so keys warmed together expire
// spread out instead of all at once.
export const ttlWithJitter = ({ baseSeconds, jitterSeconds }: Ttl): number =>
  baseSeconds + randomInt(0, jitterSeconds + 1);

export type CacheResult<T> = { value: T; hit: boolean };

// null from load() means "not found" and is returned without being cached, so a
// product created later shows up at once.
export async function cacheAside<T>(
  redis: Redis,
  key: string,
  ttl: Ttl,
  load: () => Promise<T | null>,
): Promise<CacheResult<T | null>> {
  const cached = await read(redis, key);
  if (cached !== null) {
    try {
      return { value: JSON.parse(cached) as T, hit: true };
    } catch {
      warn(`unreadable value at ${key}, treated as a miss`);
    }
  }

  const value = await load();
  if (value !== null) {
    try {
      // Always SET … EX: a SET without it would make the key live forever.
      await redis.set(key, JSON.stringify(value), 'EX', ttlWithJitter(ttl));
      recovered();
    } catch (error) {
      warn(`write failed (${errorText(error)}), the value is still returned`);
    }
  }
  return { value, hit: false };
}

async function read(redis: Redis, key: string): Promise<string | null> {
  try {
    const cached = await redis.get(key);
    recovered();
    return cached;
  } catch (error) {
    warn(`read failed (${errorText(error)}), treated as a miss`);
    return null;
  }
}
