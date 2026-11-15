import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { OutboxEntity } from '../../src/entities/index.js';
import type { OutboxMessage } from '../../src/messaging/order-placed.publisher.js';
import { type Publisher, relayBatch } from '../../src/relay/relay.js';
import { startTestDatabase, type TestDatabase } from './testkit/postgres.js';

// No broker: a fake publisher records what it was asked to publish and answers as
// told. The database is real (Testcontainers), so the locking is real too.
class FakePublisher implements Publisher {
  readonly seen: string[] = [];

  constructor(private readonly answer: (message: OutboxMessage) => Promise<boolean> = async () => true) {}

  async connect(): Promise<void> {}

  async publish(message: OutboxMessage): Promise<boolean> {
    this.seen.push(message.id);
    return this.answer(message);
  }
}

const MAX_ATTEMPTS = 3;
const options = { batchSize: 5, maxAttempts: MAX_ATTEMPTS };

describe('outbox relay', () => {
  let db: TestDatabase;

  // Waiting rows, oldest first (created_at one second apart).
  const insertRows = async (count: number, attempts = 0): Promise<string[]> => {
    const ids = Array.from({ length: count }, () => randomUUID());
    await db.admin.manager.insert(
      OutboxEntity,
      ids.map((id, i) => ({
        id,
        aggregateType: 'order',
        aggregateId: String(i + 1),
        type: 'order.placed',
        payload: { n: i },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        attempts,
      })),
    );
    return ids;
  };

  const rows = () => db.admin.manager.find(OutboxEntity, { order: { createdAt: 'ASC' } });

  // Batches until one comes back empty.
  const drain = async (publisher: Publisher) => {
    while ((await relayBatch(db.app, publisher, options)).selected > 0);
  };

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  beforeEach(async () => {
    await db.reset();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('publishes every waiting row once, oldest first, and marks each one', async () => {
    const ids = await insertRows(12);
    const publisher = new FakePublisher();

    await drain(publisher);

    expect(publisher.seen).toEqual(ids);
    expect((await rows()).every((row) => row.publishedAt !== null && row.attempts === 0)).toBe(true);
  });

  it('a publisher that throws leaves the rows waiting, with attempts + 1 committed', async () => {
    await insertRows(3);
    const publisher = new FakePublisher(async () => {
      throw new Error('broker said no');
    });

    const result = await relayBatch(db.app, publisher, options);

    expect(result).toMatchObject({ selected: 3, published: [], parked: [] });
    expect(result.failed).toHaveLength(3);
    // Read back through another connection: the increment survived the transaction.
    expect((await rows()).map(({ publishedAt, attempts }) => ({ publishedAt, attempts }))).toEqual(
      Array(3).fill({ publishedAt: null, attempts: 1 }),
    );
  });

  it('two relays at once never take the same row: each id is published exactly once', async () => {
    const ids = await insertRows(40);
    // Slow confirms, so both relays hold row locks at the same time.
    const slow = async () => {
      await sleep(20);
      return true;
    };
    const first = new FakePublisher(slow);
    const second = new FakePublisher(slow);

    await Promise.all([drain(first), drain(second)]);

    const all = [...first.seen, ...second.seen];
    expect(all).toHaveLength(ids.length);
    expect(new Set(all)).toEqual(new Set(ids));
    expect((await rows()).every((row) => row.publishedAt !== null)).toBe(true);
  });

  it('skips rows at max attempts, and reports a row that reaches it as parked', async () => {
    const [parkedId] = await insertRows(1, MAX_ATTEMPTS);
    const ok = new FakePublisher();

    expect((await relayBatch(db.app, ok, options)).selected).toBe(0);
    expect(ok.seen).toEqual([]);

    await db.admin.manager.update(OutboxEntity, { id: parkedId }, { attempts: MAX_ATTEMPTS - 1 });
    const failing = new FakePublisher(async () => false);
    const result = await relayBatch(db.app, failing, options);

    expect(result.parked).toEqual([parkedId]);
    expect((await relayBatch(db.app, ok, options)).selected).toBe(0);
    expect((await rows())[0]).toMatchObject({ attempts: MAX_ATTEMPTS, publishedAt: null });
  });
});
