import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseError } from 'pg';
import { DataSource } from 'typeorm';
import { entities } from '../entities/index.js';

// Any password in DB_URL is ignored. The file is read on every new connection,
// so rotate.sh needs no restart. DB_PASSWORD_FILE overrides the path (the tests
// point it at the container's password); the default is resolved from the
// working directory, not this file, which compiles to different depths under
// dist/ and dist-test/.
//
// poolSize: how many DB connections this process may hold at once. The API keeps
// the default 3. The consumer passes its prefetch (10): RabbitMQ gives it up to 10
// unacked messages at a time, each one handled at once with its own INSERT, so 10
// connections means none of them waits for a free one.
export const createAppDataSource = (dbUrl: string, { poolSize = 3 } = {}) => {
  const { hostname, port, pathname, username } = new URL(dbUrl);
  const passwordFile = path.resolve(process.env.DB_PASSWORD_FILE ?? 'secrets/db_password');

  return new DataSource({
    type: 'postgres',
    host: hostname,
    port: Number(port),
    database: pathname.slice(1),
    username,
    password: async () => (await readFile(passwordFile, 'utf8')).trim(),
    entities,
    synchronize: false,
    poolSize,
    poolErrorHandler: (error: Error & { code?: string }) => {
      console.error(error instanceof DatabaseError ? error.code : (error.code ?? error.message));
    },
  });
};
