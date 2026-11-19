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
}

export async function startApi(onCleanup: (fn: () => Promise<void>) => void): Promise<Api> {
  const app = configureApp(
    await NestFactory.create<NestExpressApplication>(AppModule, {
      ...appOptions,
      logger: ['error'],
      abortOnError: false,
    }),
  );
  onCleanup(() => app.close());
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, url: `http://127.0.0.1:${port}` };
}
