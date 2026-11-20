import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';

// Public: probes and load balancers carry no token.
@Public()
@Controller('health')
export class HealthCheckController {
  @Get()
  healthCheck() {
    return { uptimeSec: process.uptime() };
  }
}
