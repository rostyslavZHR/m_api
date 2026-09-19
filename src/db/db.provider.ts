import { readFile } from 'fs/promises';
import { DatabaseError, Pool } from 'pg';

export const PG_POOL = Symbol('PG_POOL');
const SECRET_FILE = new URL('../../secrets/db_password', import.meta.url);

export const createPgPool = (dbUrl: string): Pool => {
  const { hostname, port, pathname, username } = new URL(dbUrl);

  const pool = new Pool({
    host: hostname,
    port: Number(port),
    database: pathname.slice(1),
    user: username,
    password: async () => (await readFile(SECRET_FILE, 'utf8')).trim(),
    max: 3,
  });

  pool.on('error', (e) => {
    if (e instanceof DatabaseError) {
      console.log(e.code);
    } else {
      console.log((e as NodeJS.ErrnoException).code ?? e.message);
    }
  });

  return pool;
};
