import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OrderEventsModule } from '../order-events/order-events.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { OrdersGateway } from './orders.gateway.js';

// Imports the bus, never provides it: a second provider would be a second bus.
// OrdersModule supplies OrdersService for join's ownership check; AuthModule the
// keys the handshake verifies tokens with.
@Module({
  imports: [OrderEventsModule, OrdersModule, AuthModule],
  providers: [OrdersGateway],
})
export class RealtimeModule {}
