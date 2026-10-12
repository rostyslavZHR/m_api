import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { DataSource } from 'typeorm';
import { entities } from './entities/index.js';

// A DataSource as the schema owner, with the migrations attached. The TypeORM
// CLI and DB scripts get theirs from data-source.ts; the integration testkit
// builds one against its container, so tests run the same migrations.
export const createSchemaDataSource = (url: string) =>
  new DataSource({
    type: 'postgres',
    url,
    entities,
    migrations: [fileURLToPath(new URL('./migrations/*.js', import.meta.url))],
    // The schema changes only through reviewed migrations, never on startup.
    synchronize: false,
  });
