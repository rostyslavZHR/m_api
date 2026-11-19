// The app's side of the jobs queue: the producer, and the cleanup scheduler
// upserted at every start (one scheduler however many starts: a fixed id).
import { Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.schema.js';
import { REDIS_QUEUE } from '../redis/redis.module.js';
import { createJobsQueue, upsertCleanupScheduler } from './jobs.js';

@Module({
  providers: [
    {
      provide: Queue,
      useFactory: (connection: Redis) => createJobsQueue(connection),
      inject: [REDIS_QUEUE],
    },
  ],
  exports: [Queue],
})
export class JobsModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsModule.name);

  constructor(
    private readonly queue: Queue,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Not awaited: BullMQ waits for its connection to be ready, so with Redis down the
  // upsert would hold up startup indefinitely. The API serves requests without
  // Redis; the upsert completes once Redis is reachable, and a scheduler already
  // stored in Redis keeps firing meanwhile.
  onApplicationBootstrap(): void {
    const everyMs = this.config.get('CLEANUP_EVERY_MS', { infer: true });
    upsertCleanupScheduler(this.queue, everyMs).then(
      () => this.logger.log(everyMs ? `cleanup scheduler: every ${everyMs} ms` : 'cleanup scheduler: daily at 03:00'),
      (error: Error) => this.logger.error(`cleanup scheduler not upserted: ${error.message}`),
    );
  }

  // The connection belongs to RedisModule, which closes it.
  onApplicationShutdown(): Promise<void> {
    return this.queue.close();
  }
}
