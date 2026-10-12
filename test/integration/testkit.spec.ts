import { readdir } from 'node:fs/promises';
import { migrations } from '../../src/migrations/index.js';
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

  it('registers every migration file in src/migrations/index.ts', async () => {
    const files = (await readdir(new URL('../../src/migrations/', import.meta.url))).filter(
      (file) => file.endsWith('.js') && file !== 'index.js',
    );
    expect(migrations).toHaveLength(files.length);
  });

  it('applies every registered migration', async () => {
    expect(await db.admin.showMigrations()).toBe(false); // true = some still pending
    expect(await db.admin.query('SELECT count(*)::int AS applied FROM migrations')).toEqual([
      { applied: migrations.length },
    ]);
  });

  it('applies the migrations, and init.sql grants app_user read access to them', async () => {
    expect(await db.app.query('SELECT count(*)::int AS orders FROM orders')).toEqual([{ orders: 0 }]);
  });

  it('gives app_user no TRUNCATE: 42501, which is why reset() runs as admin', async () => {
    await expect(db.app.query('TRUNCATE orders CASCADE')).rejects.toMatchObject({ driverError: { code: '42501' } });
  });
});
