import { Module } from '@nestjs/common';
import { OrderPlacedFailures } from './order-placed-failures.js';
import { OrderPlacedPublisher } from './order-placed.publisher.js';

// RabbitMQ on the API side: the publisher and its failure count. Topology and
// policies come from the bootstrap; the consumer is a separate process with its
// own entrypoint.
@Module({
  providers: [OrderPlacedPublisher, OrderPlacedFailures],
  exports: [OrderPlacedPublisher, OrderPlacedFailures],
})
export class MessagingModule {}
