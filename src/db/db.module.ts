import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Env } from '../config/env.schema.js';
import { createAppDataSource } from './app-data-source.js';
import { DbController } from './db.controller.js';
import { DbService } from './db.service.js';

@Module({
  controllers: [DbController],
  providers: [
    {
      provide: DataSource,
      useFactory: (config: ConfigService<Env, true>) =>
        createAppDataSource(config.get('DB_URL', { infer: true })).initialize(),
      inject: [ConfigService],
    },
    DbService,
  ],
  exports: [DataSource, DbService],
})
export class DbModule implements OnApplicationShutdown {
  constructor(private readonly dataSource: DataSource) {}

  // Last shutdown hook, so no other module still needs the pool.
  onApplicationShutdown() {
    return this.dataSource.destroy();
  }
}
