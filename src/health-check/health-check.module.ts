import { Module } from '@nestjs/common';
import { HealthCheckController } from './health-check.controller.js';

@Module({
  controllers: [HealthCheckController],
})
export class HealthCheckModule {}
