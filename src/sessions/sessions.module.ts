import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { DbModule } from '../db/db.module.js';
import { REDIS_SESSIONS } from '../redis/redis.module.js';
import { SessionMiddleware } from './session.middleware.js';
import { SessionStore } from './session.store.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { UsersRepository } from '../users/users.repository.js';

@Module({
  imports: [DbModule],
  controllers: [SessionsController],
  providers: [
    {
      provide: SessionStore,
      useFactory: (redis: Redis) => new SessionStore(redis),
      inject: [REDIS_SESSIONS],
    },
    {
      provide: UsersRepository,
      useFactory: (dataSource: DataSource) => new UsersRepository(dataSource.manager),
      inject: [DataSource],
    },
    SessionsService,
    SessionMiddleware,
  ],
})
export class SessionsModule implements NestModule {
  // Every route: any request with the cookie renews the session.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionMiddleware).forRoutes('*path');
  }
}
