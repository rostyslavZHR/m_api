import { Module } from '@nestjs/common';
import { OrderEventsModule } from '../order-events/order-events.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { OrdersGateway } from './orders.gateway.js';

// Imports the bus, never provides it: a second provider would be a second bus.
// OrdersModule supplies OrdersService for join's ownership check.
@Module({
  imports: [OrderEventsModule, OrdersModule],
  providers: [OrdersGateway],
})
export class RealtimeModule {}
