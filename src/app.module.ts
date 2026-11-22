import { Module } from '@nestjs/common';
import { OrdersModule } from './orders/orders.module.js';
import { ProductsModule } from './products/products.module.js';
import { validateApiEnv } from './config/index.js';
import { ConfigModule } from '@nestjs/config';
import { HealthCheckModule } from './health-check/health-check.module.js';
import { DbModule } from './db/db.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { RedisModule } from './redis/redis.module.js';
import { StorageModule } from './storage/storage.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { AuthModule } from './auth/auth.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // The same check main.ts ran first; ConfigService then holds the decoded keys.
      validate: validateApiEnv,
    }),
    ProductsModule,
    OrdersModule,
    HealthCheckModule,
    DbModule,
    RedisModule,
    StorageModule,
    SessionsModule,
    JobsModule,
    AuthModule,
    RealtimeModule,
  ],
})
export class AppModule {}
