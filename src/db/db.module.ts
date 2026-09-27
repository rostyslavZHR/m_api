import { Module } from '@nestjs/common';
import { DbController } from './db.controller.js';
import { createPgPool, PG_POOL } from './db.provider.js';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { DbService } from './db.service.js';

@Module({
  controllers: [DbController],
  providers: [
    {
      provide: PG_POOL,
      useFactory: (config: ConfigService<Env, true>) =>
        createPgPool(config.get('DB_URL', { infer: true })),
      inject: [ConfigService],
    },
    DbService,
  ],
  exports: [DbService],
})
export class DbModule {}
