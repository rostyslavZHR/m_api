// The real API, started inside a demo's process on a random port: the same
// AppModule and setup as main.ts, errors only, on stderr. Its own file, not lib.ts:
// importing AppModule loads the whole app, which the other demos don't need.
// Each call is a separate app instance with its own Redis clients and DB pool.
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../app.module.js';
import { appOptions, configureApp } from '../app.setup.js';

export interface Api {
  app: NestExpressApplication;
  url: string;
  port: number;
  // Closes the app (its HTTP server, DB pool, Redis and S3 clients). Idempotent: the
  // cleanup calls it again, and a demo may call it earlier (demo:upload stops the API
  // halfway through).
  stop: () => Promise<void>;
}

export async function startApi(onCleanup: (fn: () => Promise<void>) => void): Promise<Api> {
  const app = configureApp(
    await NestFactory.create<NestExpressApplication>(AppModule, {
      ...appOptions,
      logger: ['error'],
      abortOnError: false,
    }),
  );
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= app.close());
  onCleanup(stop);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, url: `http://127.0.0.1:${port}`, port, stop };
}
