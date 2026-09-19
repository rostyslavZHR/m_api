import { Module } from '@nestjs/common';
import { OrdersModule } from './orders/orders.module.js';
import { ProductsModule } from './products/products.module.js';
import { validate } from './config/index.js';
import { ConfigModule } from '@nestjs/config';
import { HealthCheckModule } from './health-check/health-check.module.js';
import { DbModule } from './db/db.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
    ProductsModule,
    OrdersModule,
    HealthCheckModule,
    DbModule,
  ],
})
export class AppModule {}
