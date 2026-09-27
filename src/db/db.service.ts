import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from './db.provider.js';

@Injectable()
export class DbService implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getServerStatus() {
    const { rows } = await this.pool.query('SELECT current_user, now()');
    return rows[0];
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}
