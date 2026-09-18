import { Module } from '@nestjs/common';
import { OrdersModule } from './orders/orders.module.js';
import { ProductsModule } from './products/products.module.js';

@Module({
  imports: [ProductsModule, OrdersModule],
})
export class AppModule {}
