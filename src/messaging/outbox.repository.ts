import type { EntityManager } from 'typeorm';
import { OutboxEntity } from '../entities/index.js';

export interface NewOutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: object;
}

// Takes an EntityManager, like OrdersRepository: built on a transaction's manager,
// the insert is part of that transaction and commits or rolls back with it. Never
// inject a repository (or use dataSource.manager) for this: it would take its own
// pooled connection and commit on its own, i.e. the dual write again, inside one DB.
export class OutboxRepository {
  constructor(private readonly manager: EntityManager) {}

  async add(event: NewOutboxEvent): Promise<void> {
    await this.manager.insert(OutboxEntity, event);
  }
}
