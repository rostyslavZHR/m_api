import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { entities } from '../../../src/entities/index.js';
import { createSchemaDataSource } from '../../../src/schema-data-source.js';

const IMAGE = 'postgres:16-alpine'; // keep in sync with db in docker-compose.yml
const INIT_SQL = fileURLToPath(new URL('../../../../init.sql', import.meta.url));
// Read from init.sql, which the container runs, so the two can't drift.
const APP_USER_PASSWORD = /CREATE ROLE app_user LOGIN PASSWORD '([^']+)'/.exec(readFileSync(INIT_SQL, 'utf8'))?.[1];
if (!APP_USER_PASSWORD) {
  throw new Error(`No "CREATE ROLE app_user LOGIN PASSWORD '…'" in ${INIT_SQL}`);
}

export interface TestDatabase {
  // Schema owner: migrations and reset() only.
  admin: DataSource;
  // app_user: everything under test, so missing grants fail the tests.
  app: DataSource;
  appUrl: string;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  // admin must be the superuser: init.sql's default privileges are FOR ROLE admin.
  const container = await new PostgreSqlContainer(IMAGE)
    .withUsername('admin')
    .withPassword('admin-test-only')
    .withDatabase('shop')
    .withCopyFilesToContainer([{ source: INIT_SQL, target: '/docker-entrypoint-initdb.d/init.sql' }])
    .start();

  const admin = createSchemaDataSource(container.getConnectionUri());
  const appUrl = `postgres://app_user:${APP_USER_PASSWORD}@${container.getHost()}:${container.getPort()}/shop`;
  const app = new DataSource({ type: 'postgres', url: appUrl, entities });

  const stop = async () => {
    if (app.isInitialized) await app.destroy();
    if (admin.isInitialized) await admin.destroy();
    await container.stop();
  };

  try {
    await admin.initialize();
    await admin.runMigrations();
    await app.initialize();
  } catch (error) {
    await stop();
    throw error;
  }

  // TRUNCATE rather than a per-test rollback: checkout commits its own
  // transactions. Entity tables only, so the migrations table survives.
  const tables = admin.entityMetadatas.map(({ tableName }) => `"${tableName}"`).join(', ');
  const reset = async () => {
    await admin.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  };

  return { admin, app, appUrl, reset, stop };
}
