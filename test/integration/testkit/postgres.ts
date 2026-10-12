import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { entities } from '../../../src/entities/index.js';
import { createSchemaDataSource } from '../../../src/schema-data-source.js';

// A throwaway copy of the compose db: same image, admin as the superuser (the
// default privileges in init.sql are FOR ROLE admin), init.sql applied by the
// image's entrypoint on first start, then the real migrations. Never the
// compose db or PgBouncer.
const IMAGE = 'postgres:16-alpine'; // keep in sync with db in docker-compose.yml
const INIT_SQL = fileURLToPath(new URL('../../../../init.sql', import.meta.url));
// The starting password init.sql gives app_user.
const APP_USER_PASSWORD = 'app-v1-password';

export interface TestDatabase {
  // Schema owner: migrations, seeding, TRUNCATE.
  admin: DataSource;
  // app_user, the role the app runs as: the code under test uses this one.
  app: DataSource;
  appUrl: string;
  // Closes both pools, then stops the container. Call it in afterAll.
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
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

  return { admin, app, appUrl, stop };
}
