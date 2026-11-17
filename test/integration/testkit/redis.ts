import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Redis } from 'ioredis';
import { closeRedis, createCacheClient, createSessionClient } from '../../../src/redis/redis-clients.js';

// Keep in sync with docker-compose.yml: the image, and each instance's policies.
const IMAGE = 'redis:8.10.3-alpine';
const CACHE_ARGS = ['--maxmemory', '32mb', '--maxmemory-policy', 'allkeys-lru', '--save', '', '--appendonly', 'no'];
const QUEUE_ARGS = ['--maxmemory', '256mb', '--maxmemory-policy', 'noeviction', '--appendonly', 'yes', '--appendfsync', 'everysec'];

export interface TestRedis {
  // The app's own client for this instance (cache or sessions), on the container.
  client: Redis;
  url: string;
  // Plain redis-cli in the container, for TTL, SCAN, CONFIG SET, FLUSHALL.
  cli(...args: string[]): Promise<string>;
  stop(): Promise<void>;
}
export type TestCache = TestRedis;

// Configured like redis-cache, with the cache client.
export const startTestCache = () => startTestRedis(CACHE_ARGS, createCacheClient);

// Configured like redis-queue, with the sessions client.
export const startTestQueue = () => startTestRedis(QUEUE_ARGS, createSessionClient);

async function startTestRedis(args: string[], createClient: (url: string) => Redis): Promise<TestRedis> {
  const container: StartedRedisContainer = await new RedisContainer(IMAGE)
    .withCommand(['redis-server', ...args])
    .start();
  const url = container.getConnectionUrl();
  const client = createClient(url);
  // Both clients fail fast: they don't queue commands before the connection is up.
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve);
    client.once('end', () => reject(new Error('the test Redis client could not connect')));
  });

  const cli = async (...cliArgs: string[]) => {
    const { output, exitCode } = await container.exec(['redis-cli', ...cliArgs]);
    if (exitCode !== 0) throw new Error(`redis-cli ${cliArgs.join(' ')}: ${output}`);
    return output.trim();
  };

  return {
    client,
    url,
    cli,
    stop: async () => {
      await closeRedis(client);
      await container.stop();
    },
  };
}
