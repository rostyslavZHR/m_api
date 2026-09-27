import { Controller, Get } from '@nestjs/common';
import { DbService } from './db.service.js';

@Controller('db')
export class DbController {
  constructor(private readonly dbService: DbService) {}

  @Get()
  async check() {
    return this.dbService.getServerStatus();
  }
}
