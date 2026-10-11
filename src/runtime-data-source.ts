import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import { entities } from './entities/index.js';

// Used by the concurrency demos, which exercise the app's runtime path: same
// user (app_user), same DB_URL (PgBouncer, transaction mode), and the password
// read from secrets/db_password like the app's own pool (src/db/db.provider.ts).
// The schema owner's data-source.ts stays for migrations, seed and reports:
// PgBouncer can't log in a superuser here, because get_auth() returns nothing
// for one, and app_user has no DDL rights.
const url = process.env.DB_URL;
if (!url) {
  throw new Error('DB_URL is not set — create .env from .env.example, or export it');
}

const SECRET_FILE = new URL('../secrets/db_password', import.meta.url);
const { hostname, port, pathname, username } = new URL(url);

export const runtimeDataSource = new DataSource({
  type: 'postgres',
  host: hostname,
  port: Number(port),
  database: pathname.slice(1),
  username,
  password: async () => (await readFile(SECRET_FILE, 'utf8')).trim(),
  entities,
  synchronize: false,
});
