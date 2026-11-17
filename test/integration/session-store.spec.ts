// SessionStore on a real Redis configured like redis-queue (noeviction, AOF), with
// the app's sessions client. Short TTLs here, so expiry is observable in seconds.
import { closeRedis, createSessionClient } from '../../src/redis/redis-clients.js';
import { SESSION_TTL, SessionStore } from '../../src/sessions/session.store.js';
import { startTestQueue, type TestRedis } from './testkit/redis.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SessionStore (Redis, rolling TTL)', () => {
  let redis: TestRedis;

  const ttlOf = async (id: string) => Number(await redis.cli('TTL', `sess:${id}`));
  const sessionKeys = async () => (await redis.cli('--scan', '--pattern', 'sess:*')).split('\n').filter(Boolean);

  beforeAll(async () => {
    redis = await startTestQueue();
  });

  beforeEach(async () => {
    await redis.cli('FLUSHALL');
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it('creates sess:<id> with the idle TTL and reads the same session back', async () => {
    const store = new SessionStore(redis.client);

    const { id, data } = await store.create(7);

    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await ttlOf(id)).toBe(SESSION_TTL.idleSeconds);
    expect(await store.touch(id)).toEqual(data);
    expect(await store.touch(id)).toEqual({ userId: 7, createdAt: data.createdAt });
  });

  it('activity pushes the TTL back up to the full idle time', async () => {
    const store = new SessionStore(redis.client, { idleSeconds: 10, absoluteSeconds: 3600 });
    const { id } = await store.create(7);

    await sleep(2_100);
    const before = await ttlOf(id);
    await store.touch(id);
    const after = await ttlOf(id);

    expect(before).toBeLessThanOrEqual(8);
    expect(after).toBe(10);
  });

  it('an idle session expires: touch returns null, nothing is recreated', async () => {
    const store = new SessionStore(redis.client, { idleSeconds: 1, absoluteSeconds: 3600 });
    const { id } = await store.create(7);

    await sleep(2_100);

    expect(await store.touch(id)).toBeNull();
    expect(await sessionKeys()).toEqual([]);
  });

  it('an always-active session still ends at its absolute lifetime, and its key is deleted', async () => {
    const store = new SessionStore(redis.client, { idleSeconds: 60, absoluteSeconds: 3600 });
    const { id } = await store.create(7, new Date(Date.now() - 3601 * 1000));

    expect(await store.touch(id)).toBeNull();
    expect(await sessionKeys()).toEqual([]);
  });

  it('an unreadable value is treated as expired: null, and the key is deleted', async () => {
    const store = new SessionStore(redis.client);
    const { id } = await store.create(7);
    await redis.cli('SET', `sess:${id}`, 'not json', 'EX', '60');

    expect(await store.touch(id)).toBeNull();
    expect(await sessionKeys()).toEqual([]);
  });

  it('a malformed id never reaches Redis as a key', async () => {
    const store = new SessionStore(redis.client);

    expect(await store.touch('../../etc/passwd')).toBeNull();
    expect(await store.touch('')).toBeNull();
    expect(await sessionKeys()).toEqual([]);
  });

  it('a second store on the same Redis (another app instance) reads the same session', async () => {
    const other = createSessionClient(redis.url);
    // Fail-fast client: no commands before the connection is ready.
    await new Promise((resolve) => other.once('ready', resolve));
    try {
      const { id, data } = await new SessionStore(redis.client).create(7);

      expect(await new SessionStore(other).touch(id)).toEqual(data);
    } finally {
      await closeRedis(other);
    }
  });

  it('Redis unreachable: touch throws (the caller answers 503), it never reports "no session"', async () => {
    const dead = createSessionClient('redis://127.0.0.1:1');
    try {
      await expect(new SessionStore(dead).touch('A'.repeat(43))).rejects.toThrow();
    } finally {
      await closeRedis(dead);
    }
  });
});
