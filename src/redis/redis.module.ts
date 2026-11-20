import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.schema.js';
import {
  closeRedis,
  createCacheClient,
  createQueueClient,
  createRateLimitClient,
  createSessionClient,
} from './redis-clients.js';

// Injection tokens: @Inject(REDIS_CACHE) / @Inject(REDIS_QUEUE) / @Inject(REDIS_SESSIONS) / @Inject(REDIS_RATE_LIMIT).
export const REDIS_CACHE = Symbol('REDIS_CACHE');
export const REDIS_QUEUE = Symbol('REDIS_QUEUE');
// The queue instance, through its own fail-fast clients (see createSessionClient
// and createRateLimitClient).
export const REDIS_SESSIONS = Symbol('REDIS_SESSIONS');
export const REDIS_RATE_LIMIT = Symbol('REDIS_RATE_LIMIT');

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CACHE,
      useFactory: (config: ConfigService<Env, true>) =>
        createCacheClient(config.get('REDIS_CACHE_URL', { infer: true })),
      inject: [ConfigService],
    },
    {
      provide: REDIS_QUEUE,
      useFactory: (config: ConfigService<Env, true>) =>
        createQueueClient(config.get('REDIS_QUEUE_URL', { infer: true })),
      inject: [ConfigService],
    },
    {
      provide: REDIS_SESSIONS,
      useFactory: (config: ConfigService<Env, true>) =>
        createSessionClient(config.get('REDIS_QUEUE_URL', { infer: true })),
      inject: [ConfigService],
    },
    {
      provide: REDIS_RATE_LIMIT,
      useFactory: (config: ConfigService<Env, true>) =>
        createRateLimitClient(config.get('REDIS_QUEUE_URL', { infer: true })),
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CACHE, REDIS_QUEUE, REDIS_SESSIONS, REDIS_RATE_LIMIT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CACHE) private readonly cache: Redis,
    @Inject(REDIS_QUEUE) private readonly queue: Redis,
    @Inject(REDIS_SESSIONS) private readonly sessions: Redis,
    @Inject(REDIS_RATE_LIMIT) private readonly rateLimit: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      closeRedis(this.cache),
      closeRedis(this.queue),
      closeRedis(this.sessions),
      closeRedis(this.rateLimit),
    ]);
  }
}
