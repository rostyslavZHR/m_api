import { Controller, Get } from '@nestjs/common';
import { DbService } from './db.service.js';
import { Public } from '../auth/public.decorator.js';

// Public: a health probe, like /health.
@Public()
@Controller('db')
export class DbController {
  constructor(private readonly dbService: DbService) {}

  @Get()
  async check() {
    return this.dbService.getServerStatus();
  }
}
