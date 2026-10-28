import { Module } from '@nestjs/common';
import { OrderEventsBus } from './order-events.bus.js';

// The bus is provided here and only here. Nest creates one instance per `providers`
// list, so listing OrderEventsBus in another module would create a second bus: events
// published into one never reach subscribers of the other, and nothing errors.
// Modules that need the bus import OrderEventsModule instead.

@Module({
  providers: [OrderEventsBus],
  exports: [OrderEventsBus],
})
export class OrderEventsModule {}
