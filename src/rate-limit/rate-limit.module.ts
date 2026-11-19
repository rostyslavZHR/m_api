import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_RATE_LIMIT } from '../redis/redis.module.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimiter } from './rate-limiter.js';

// Imported by the modules whose controllers use @UseGuards(RateLimitGuard): the
// guard is created in their scope and needs the RateLimiter there.
@Module({
  providers: [
    {
      provide: RateLimiter,
      useFactory: (redis: Redis) => new RateLimiter(redis),
      inject: [REDIS_RATE_LIMIT],
    },
    RateLimitGuard,
  ],
  exports: [RateLimiter, RateLimitGuard],
})
export class RateLimitModule {}
