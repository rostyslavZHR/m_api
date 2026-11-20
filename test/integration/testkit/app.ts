import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { appOptions, configureApp } from '../../../src/app.setup.js';
import type { TestDatabase } from './postgres.js';

// The real AppModule with no overrides and the same setup as main.ts, on the
// test container. Shared by the E2E tests and the Pact provider verification.
let jwtEnv: Record<string, string> | undefined;
function testJwtEnv(): Record<string, string> {
  if (!jwtEnv) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const base64 = (pem: string) => Buffer.from(pem).toString('base64');
    jwtEnv = {
      JWT_PRIVATE_KEY: base64(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string),
      JWT_PUBLIC_KEY: base64(publicKey.export({ type: 'spki', format: 'pem' }) as string),
      JWT_KID: 'test-2026-11',
      REFRESH_TOKEN_PEPPER: randomBytes(32).toString('base64url'),
    };
  }
  return jwtEnv;
}

// env: overrides for this test file, e.g. REDIS_QUEUE_URL pointing at a Redis
// Testcontainer. Applied before the first import of AppModule, which reads the
// environment once per test file: every app in a file gets the same values.
export async function createTestApp(db: TestDatabase, env: Record<string, string> = {}): Promise<NestExpressApplication> {
  // The app reads its password from a file, not DB_URL. Give it the container's,
  // so the tests don't depend on a secrets/db_password a fresh clone lacks.
  const passwordFile = path.join(await mkdtemp(path.join(tmpdir(), 'm-api-test-')), 'db_password');
  await writeFile(passwordFile, decodeURIComponent(new URL(db.appUrl).password));
  process.env.DB_PASSWORD_FILE = passwordFile;

  // ConfigModule reads and validates the environment when app.module.ts is
  // first imported. A static import would run before this line and take
  // DB_URL from .env: PgBouncer and the dev database.
  process.env.DB_URL = db.appUrl;
  // Required by the env schema. The suites don't use RabbitMQ: a port nothing
  // listens on, so they never depend on a running broker.
  process.env.RABBITMQ_URL = 'amqp://127.0.0.1:1';
  // The same for Redis, until a suite needs it.
  process.env.REDIS_CACHE_URL = 'redis://127.0.0.1:1';
  process.env.REDIS_QUEUE_URL = 'redis://127.0.0.1:1';
  // The JWT keys the API requires: a throwaway ES256 set per test file, never the
  // vault's, and the same for every app the file starts (AppModule reads the
  // environment once, and tokens minted by the test must verify on all of them).
  Object.assign(process.env, testJwtEnv());
  Object.assign(process.env, env);
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
