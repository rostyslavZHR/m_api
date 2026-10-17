import { createSchemaDataSource } from './schema-data-source.js';

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

export const dataSource = createSchemaDataSource(url);
