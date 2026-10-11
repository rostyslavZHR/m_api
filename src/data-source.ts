import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { DataSource } from 'typeorm';
import { entities } from './entities/index.js';

// Used by the TypeORM CLI and the DB scripts, never by the app. It connects as
// the schema owner, not app_user: app_user has no table privileges, and
// migrations run DDL. The URL comes from scripts/with-secrets.sh.
const url = process.env.MIGRATIONS_DB_URL;
if (!url) {
  throw new Error(
    'MIGRATIONS_DB_URL is not set — run through scripts/with-secrets.sh, ' +
      'or export it and set SKIP_VAULT=1',
  );
}

export const dataSource = new DataSource({
  type: 'postgres',
  url,
  entities,
  migrations: [fileURLToPath(new URL('./migrations/*.js', import.meta.url))],
  // The schema changes only through reviewed migrations, never on startup.
  synchronize: false,
});
