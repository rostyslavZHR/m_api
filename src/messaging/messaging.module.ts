import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { OrderPlacedPublisher } from './order-placed.publisher.js';

// The publisher as a Nest provider, for the demos' application context. The relay
// (src/relay/main.ts) is a plain process and constructs it directly; the API's
// order path no longer publishes (it writes to the outbox).
@Module({
  providers: [
    {
      provide: OrderPlacedPublisher,
      useFactory: (config: ConfigService<Env, true>) =>
        new OrderPlacedPublisher(config.get('RABBITMQ_URL', { infer: true })),
      inject: [ConfigService],
    },
  ],
  exports: [OrderPlacedPublisher],
})
export class MessagingModule {}
