import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { entities } from './entities/index.js';
import { migrations } from './migrations/index.js';

// The schema owner's DataSource, shared by the TypeORM CLI (data-source.ts) and
// the integration testkit, so both run the same migrations.
export const createSchemaDataSource = (url: string) =>
  new DataSource({
    type: 'postgres',
    url,
    entities,
    migrations,
    synchronize: false,
  });
