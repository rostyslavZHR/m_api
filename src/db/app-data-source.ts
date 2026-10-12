import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseError } from 'pg';
import { DataSource } from 'typeorm';
import { entities } from '../entities/index.js';

// From the working directory, not this file: it compiles to different depths
// under dist/ and dist-test/, while everything runs from the repo root.
const PASSWORD_FILE = path.resolve('secrets/db_password');

// Any password in DB_URL is ignored. The file is read on every new connection,
// so rotate.sh needs no restart.
export const createAppDataSource = (dbUrl: string) => {
  const { hostname, port, pathname, username } = new URL(dbUrl);

  return new DataSource({
    type: 'postgres',
    host: hostname,
    port: Number(port),
    database: pathname.slice(1),
    username,
    password: async () => (await readFile(PASSWORD_FILE, 'utf8')).trim(),
    entities,
    synchronize: false,
    poolSize: 3,
    poolErrorHandler: (error: Error & { code?: string }) => {
      console.error(error instanceof DatabaseError ? error.code : (error.code ?? error.message));
    },
  });
};
