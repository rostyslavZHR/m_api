import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.schema.js';
import { closeRedis, createCacheClient, createQueueClient, createSessionClient } from './redis-clients.js';

// Injection tokens: @Inject(REDIS_CACHE) / @Inject(REDIS_QUEUE) / @Inject(REDIS_SESSIONS).
export const REDIS_CACHE = Symbol('REDIS_CACHE');
export const REDIS_QUEUE = Symbol('REDIS_QUEUE');
// The queue instance, through its own fail-fast client (see createSessionClient).
export const REDIS_SESSIONS = Symbol('REDIS_SESSIONS');

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
  ],
  exports: [REDIS_CACHE, REDIS_QUEUE, REDIS_SESSIONS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CACHE) private readonly cache: Redis,
    @Inject(REDIS_QUEUE) private readonly queue: Redis,
    @Inject(REDIS_SESSIONS) private readonly sessions: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([closeRedis(this.cache), closeRedis(this.queue), closeRedis(this.sessions)]);
  }
}
