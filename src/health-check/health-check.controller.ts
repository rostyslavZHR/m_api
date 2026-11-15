import { Controller, Get } from '@nestjs/common';
import { OrderPlacedFailures } from '../messaging/order-placed-failures.js';

@Controller('health')
export class HealthCheckController {
  constructor(private readonly orderPlacedFailures: OrderPlacedFailures) {}

  // orderPlacedUnpublished: committed orders whose order.placed event this process
  // couldn't publish since it started. Anything above 0 is an event lost to the
  // broker; the log has each one's orderId.
  @Get()
  healthCheck() {
    return {
      uptimeSec: process.uptime(),
      orderPlacedUnpublished: this.orderPlacedFailures.total,
    };
  }
}
