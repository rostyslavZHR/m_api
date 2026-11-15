import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module.js';
import { HealthCheckController } from './health-check.controller.js';

@Module({
  imports: [MessagingModule],
  controllers: [HealthCheckController],
})
export class HealthCheckModule {}
