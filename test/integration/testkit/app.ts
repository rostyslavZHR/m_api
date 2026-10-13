import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { appOptions, configureApp } from '../../../src/app.setup.js';
import type { TestDatabase } from './postgres.js';

// The real AppModule with no overrides and the same setup as main.ts, on the
// test container. Shared by the E2E tests and the Pact provider verification.
export async function createTestApp(db: TestDatabase): Promise<NestExpressApplication> {
  // ConfigModule reads and validates the environment when app.module.ts is
  // first imported. A static import would run before this line and take
  // DB_URL from .env: PgBouncer and the dev database.
  process.env.DB_URL = db.appUrl;
  const { AppModule } = await import('../../../src/app.module.js');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(appOptions));
  await app.init();

  // Stop before any request can write to the wrong database.
  const { port } = app.get(DataSource).options as { port?: number };
  if (port !== Number(new URL(db.appUrl).port)) {
    await app.close();
    throw new Error(`The app connected to port ${port}, not the test container`);
  }

  return app;
}
