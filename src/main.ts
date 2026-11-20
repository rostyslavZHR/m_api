import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type ApiEnv, validateApiEnv } from './config/env.schema.js';
import { JWT_ALG, keyFingerprint } from './config/jwt-keys.js';

// The config first, before anything connects: a missing or broken variable stops the
// process here, with its name, instead of surfacing later as ECONNREFUSED from the DB
// pool or as a failure at the first login. AppModule is imported only after this
// (a dynamic import), so none of its modules can start work before the check.
let env: ApiEnv;
try {
  env = validateApiEnv(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// Which key this process signs with: the kid and the public key's fingerprint, never
// the key itself.
new Logger('Bootstrap').log(`JWT ${JWT_ALG} kid=${env.JWT_KID} fingerprint=${keyFingerprint(env.JWT_PUBLIC_KEY)}`);

const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('./app.module.js');
const { appOptions, configureApp } = await import('./app.setup.js');

const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, appOptions));
app.enableShutdownHooks();
await app.listen(env.PORT);
