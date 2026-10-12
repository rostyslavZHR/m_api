import { startTestDatabase, type TestDatabase } from './testkit/postgres.js';

describe('testkit', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('connects to the container as app_user', async () => {
    expect(await db.app.query('SELECT 1 AS one, current_user AS role')).toEqual([{ one: 1, role: 'app_user' }]);
  });

  it('applies the migrations, and init.sql grants app_user read access to them', async () => {
    expect(await db.app.query('SELECT count(*)::int AS orders FROM orders')).toEqual([{ orders: 0 }]);
  });
});
