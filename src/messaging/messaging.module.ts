import { Module } from '@nestjs/common';
import { OrderPlacedPublisher } from './order-placed.publisher.js';

// RabbitMQ on the API side: only the publisher. Topology and policies come from
// the bootstrap; the consumer is a separate process with its own entrypoint.
@Module({
  providers: [OrderPlacedPublisher],
  exports: [OrderPlacedPublisher],
})
export class MessagingModule {}
