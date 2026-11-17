// Cache-aside with a single-flight lock: read Redis; on a miss, one caller (the
// leader) takes a short lock and loads from the database, the others (waiters)
// poll the cache until the leader's value appears. So a key that just expired
// costs one database call, not one per concurrent request (the stampede).
//
// The cache can only make a request faster, never fail it: a failed read is a
// miss, a failed write is logged and the loaded value returned anyway, and when
// Redis itself errors nobody waits for a lock: straight to the database.
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Redis } from 'ioredis';
import { errorText, warnOnce } from './warn-once.js';

const { warn, ok: recovered } = warnOnce('cache');

export interface Ttl {
  baseSeconds: number;
  jitterSeconds: number;
}

export interface SingleFlight {
  // The lock expires by itself after this: a leader that died frees it.
  lockTtlMs: number;
  // Waiters re-read every pollMs + 0..pollJitterMs, so they don't poll in lockstep.
  pollMs: number;
  pollJitterMs: number;
  // A waiter gives up after this and loads itself. At least lockTtlMs, or waiters
  // would give up while a slow leader is still working.
  waitMs: number;
}

export const SINGLE_FLIGHT: SingleFlight = { lockTtlMs: 3_000, pollMs: 25, pollJitterMs: 25, waitMs: 3_500 };

// base + 0..jitter seconds, both ends included, so keys warmed together expire
// spread out instead of all at once.
export const ttlWithJitter = ({ baseSeconds, jitterSeconds }: Ttl): number =>
  baseSeconds + randomInt(0, jitterSeconds + 1);

// How the value was served. hit and waiter came from the cache (a waiter can also
// load, when the leader stored nothing); the others ran load().
export type CacheRole = 'hit' | 'leader' | 'waiter' | 'timeout' | 'fail-open';

export interface CacheResult<T> {
  value: T;
  hit: boolean;
  role: CacheRole;
}

export const lockKey = (key: string) => `lock:${key}`;

// null from load() means "not found" and is returned without being cached, so a
// product created later shows up at once.
export async function cacheAside<T>(
  redis: Redis,
  key: string,
  ttl: Ttl,
  load: () => Promise<T | null>,
  singleFlight: SingleFlight = SINGLE_FLIGHT,
): Promise<CacheResult<T | null>> {
  const first = await read<T>(redis, key);
  if (first.found) return { value: first.value, hit: true, role: 'hit' };
  // Redis didn't answer: no lock, no waiting.
  if (first.failed) return { value: await loadAndStore(redis, key, ttl, load), hit: false, role: 'fail-open' };

  const token = randomUUID();
  let leader: boolean;
  try {
    leader = (await redis.set(lockKey(key), token, 'PX', singleFlight.lockTtlMs, 'NX')) === 'OK';
  } catch (error) {
    warn(`lock failed (${errorText(error)}), loading without it`);
    return { value: await loadAndStore(redis, key, ttl, load), hit: false, role: 'fail-open' };
  }

  if (leader) {
    try {
      // Re-check: a leader that just finished may have stored the value between
      // our miss and our lock; without this read we'd load it a second time.
      const again = await read<T>(redis, key);
      if (again.found) return { value: again.value, hit: true, role: 'hit' };
      return { value: await loadAndStore(redis, key, ttl, load), hit: false, role: 'leader' };
    } finally {
      await releaseLock(redis, lockKey(key), token);
    }
  }

  return waitForLeader(redis, key, ttl, load, singleFlight);
}

async function waitForLeader<T>(
  redis: Redis,
  key: string,
  ttl: Ttl,
  load: () => Promise<T | null>,
  { pollMs, pollJitterMs, waitMs }: SingleFlight,
): Promise<CacheResult<T | null>> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(pollMs + randomInt(0, pollJitterMs + 1));
    const poll = await pollLeader<T>(redis, key);
    if (poll.found) return { value: poll.value, hit: true, role: 'waiter' };
    // The lock is gone and there's still no value: the leader found nothing (not
    // found isn't cached) or failed. Or Redis stopped answering. Don't wait on.
    if (poll.failed || !poll.locked) {
      return { value: await loadAndStore(redis, key, ttl, load), hit: false, role: 'waiter' };
    }
  }
  return { value: await loadAndStore(redis, key, ttl, load), hit: false, role: 'timeout' };
}

// Release only our own lock: DELEX … IFEQ deletes the key only if it still holds
// our token (Redis 8.4+, one atomic command; ioredis has no method for it, hence
// call()). A plain DEL could remove the next leader's lock after ours expired. A
// failed release is logged; the lock's TTL frees it anyway.
export async function releaseLock(redis: Redis, key: string, token: string): Promise<boolean> {
  try {
    return (await redis.call('DELEX', key, 'IFEQ', token)) === 1;
  } catch (error) {
    warn(`lock release failed (${errorText(error)}), it expires by its TTL`);
    return false;
  }
}

async function loadAndStore<T>(redis: Redis, key: string, ttl: Ttl, load: () => Promise<T | null>): Promise<T | null> {
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
  return value;
}

type Read<T> = { found: true; value: T } | { found: false; failed: boolean };

async function read<T>(redis: Redis, key: string): Promise<Read<T>> {
  try {
    const cached = await redis.get(key);
    recovered();
    return parse<T>(key, cached);
  } catch (error) {
    warn(`read failed (${errorText(error)}), treated as a miss`);
    return { found: false, failed: true };
  }
}

// One round trip (MULTI), in this order: is the lock still held, then the value.
// The leader stores the value before releasing the lock, so "no lock" followed by
// "no value" really means the leader stored nothing.
async function pollLeader<T>(redis: Redis, key: string): Promise<Read<T> & { locked?: boolean }> {
  try {
    const replies = (await redis.multi().exists(lockKey(key)).get(key).exec()) ?? [];
    const [[lockError, locked], [getError, cached]] = replies as [[Error | null, number], [Error | null, string | null]];
    if (lockError || getError) throw lockError ?? getError;
    return { ...parse<T>(key, cached), locked: locked === 1 };
  } catch (error) {
    warn(`read failed (${errorText(error)}), treated as a miss`);
    return { found: false, failed: true };
  }
}

function parse<T>(key: string, cached: string | null): Read<T> {
  if (cached === null) return { found: false, failed: false };
  try {
    return { found: true, value: JSON.parse(cached) as T };
  } catch {
    warn(`unreadable value at ${key}, treated as a miss`);
    return { found: false, failed: false };
  }
}
