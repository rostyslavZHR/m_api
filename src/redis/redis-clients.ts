// The only place that creates Redis clients. Two instances, two clients, each tuned
// for its job. Plain functions, so scripts and demos use them too; RedisModule wraps
// them for Nest.
import { Redis } from 'ioredis';

// A slow cache must become a miss, not a slow request: a command gets 200 ms, and
// while the connection is down commands fail at once instead of queueing for later.
// The caller treats any error as a miss and reads the database.
export const CACHE_COMMAND_TIMEOUT_MS = 200;

export const createCacheClient = (url: string): Redis =>
  named(
    new Redis(url, {
      commandTimeout: CACHE_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      connectionName: 'm_api:cache',
    }),
    'cache',
  );

// The BullMQ producer (Queue: add, the scheduler) on the queue instance. Fails fast
// while Redis is down, as BullMQ recommends for producers: the caller sees the
// error at once (the consumer requeues its message) instead of waiting on
// commands queued for a reconnect.
export const createQueueClient = (url: string): Redis =>
  named(new Redis(url, { connectionName: 'm_api:queue', enableOfflineQueue: false }), 'queue');

// The BullMQ worker's connection: the opposite of the cache. maxRetriesPerRequest:
// null (BullMQ requires it for workers) makes its blocking commands wait for Redis
// to come back instead of failing, so a Redis restart pauses the worker and
// doesn't crash it.
export const createWorkerClient = (url: string): Redis =>
  named(new Redis(url, { connectionName: 'm_api:worker', maxRetriesPerRequest: null }), 'worker');

// Sessions live on the queue instance (noeviction, AOF) but get their own client:
// a session is read on every request that carries the cookie, so it must not hang
// while Redis is down. Fail fast like the cache, with a little more time (a
// session read is not optional the way a cache read is): the request gets a 503,
// never a 401, so a Redis blip doesn't look like a logout.
export const SESSION_COMMAND_TIMEOUT_MS = 500;

export const createSessionClient = (url: string): Redis =>
  named(
    new Redis(url, {
      commandTimeout: SESSION_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      connectionName: 'm_api:sessions',
    }),
    'sessions',
  );

// Rate-limit counters live on the queue instance too (noeviction: on the cache an
// evicted counter would hand its client a fresh allowance), with their own
// fail-fast client: the check runs before every limited request, and when Redis
// doesn't answer the guard lets the request through, so it must give up quickly.
export const RATE_LIMIT_COMMAND_TIMEOUT_MS = 200;

export const createRateLimitClient = (url: string): Redis =>
  named(
    new Redis(url, {
      commandTimeout: RATE_LIMIT_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      connectionName: 'm_api:rate-limit',
    }),
    'rate-limit',
  );

// Without a listener ioredis prints every reconnect error as "Unhandled error
// event"; one line per distinct error is enough.
function named(client: Redis, name: string): Redis {
  let last = '';
  client.on('error', (error: Error) => {
    if (error.message === last) return;
    last = error.message;
    console.error(`[redis ${name}] ${error.message}`);
  });
  client.on('ready', () => {
    last = '';
  });
  return client;
}

// quit() waits for pending replies; disconnect() if the connection is already gone.
export async function closeRedis(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
