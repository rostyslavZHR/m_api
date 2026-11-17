import type { EntityManager } from 'typeorm';

export interface KeyRef {
  userId: string;
  key: string;
}

export interface StoredKey {
  fingerprint: string;
  orderId: string;
}

// Takes the checkout transaction's EntityManager, like the other repositories, so
// the key commits (or rolls back) with the order it creates.
export class IdempotencyKeysRepository {
  constructor(private readonly manager: EntityManager) {}

  // true = this request now owns the key. false = the key exists (committed by an
  // earlier request): a replay. A concurrent request with the same key waits here
  // on the primary key's index until the first one commits (→ false) or rolls back
  // (→ true, and it takes the key over). The unique index is the check: no
  // "SELECT first", which two concurrent requests would both pass.
  async claim({ userId, key }: KeyRef, fingerprint: string): Promise<boolean> {
    const rows: unknown[] = await this.manager.query(
      `INSERT INTO idempotency_keys (user_id, key, fingerprint)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO NOTHING
       RETURNING key`,
      [userId, key, fingerprint],
    );
    return rows.length === 1;
  }

  async attachOrder({ userId, key }: KeyRef, orderId: string): Promise<void> {
    await this.manager.query(
      'UPDATE idempotency_keys SET order_id = $3 WHERE user_id = $1 AND key = $2',
      [userId, key, orderId],
    );
  }

  // After a failed claim: the row is committed, so it has its order.
  async find({ userId, key }: KeyRef): Promise<StoredKey> {
    const [row] = (await this.manager.query(
      'SELECT fingerprint, order_id AS "orderId" FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [userId, key],
    )) as StoredKey[];
    if (!row?.orderId) {
      throw new Error(`idempotency key ${key} exists without an order`);
    }
    return row;
  }
}
