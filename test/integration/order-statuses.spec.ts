import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { ORDER_STATUSES } from '../../src/entities/index.js';
import { startTestDatabase, type TestDatabase } from './testkit/postgres.js';

// ORDER_STATUSES is the source; the migrated CHECK and the spec enum are hand-written
// copies, so a status added to one place alone turns these red.
describe('order statuses', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('match the orders_status_check constraint in the migrated database', async () => {
    const [{ definition }] = await db.admin.query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'orders_status_check'`,
    );
    // CHECK ((status = ANY (ARRAY['paid'::text, …]))): every quoted literal is a status.
    const inDb = [...(definition as string).matchAll(/'([^']+)'/g)].map(([, status]) => status);
    expect(inDb.sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it("match the spec's OrderStatus enum", async () => {
    const spec = parse(await readFile('openapi/openapi.yaml', 'utf8'));
    expect([...spec.components.schemas.OrderStatus.enum].sort()).toEqual([...ORDER_STATUSES].sort());
  });
});
