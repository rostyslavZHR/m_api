import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface ServerStatus {
  current_user: string;
  now: Date;
}

@Injectable()
export class DbService {
  constructor(private readonly dataSource: DataSource) {}

  async getServerStatus(): Promise<ServerStatus> {
    const [status] = await this.dataSource.query<ServerStatus[]>('SELECT current_user, now()');
    return status;
  }
}
