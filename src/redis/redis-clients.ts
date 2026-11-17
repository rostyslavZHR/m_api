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

// The queue instance holds jobs and sessions, which must not be dropped: ioredis's
// defaults (commands queue while reconnecting, retried). BullMQ's worker gets its
// own connection with maxRetriesPerRequest: null in Phase F (wait for Redis).
export const createQueueClient = (url: string): Redis =>
  named(new Redis(url, { connectionName: 'm_api:queue' }), 'queue');

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
