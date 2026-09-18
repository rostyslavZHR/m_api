import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { AppModule } from './app.module.js';
import { buildProblem } from './common/problem.js';
import { ProblemExceptionFilter } from './common/problem-exception.filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });

  app.use(express.json());

  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(__dirname, '..', 'openapi', 'openapi.yaml'),
      validateRequests: true,
      validateResponses: true,
    }),
  );

  app.useGlobalFilters(new ProblemExceptionFilter());

  // express-openapi-validator runs as raw Express middleware, ahead of Nest's
  // own router, so its errors never reach ProblemExceptionFilter (a Nest
  // filter only sees exceptions from within Nest's request pipeline). This
  // is the fallback for that pre-router layer.
  app.use((err: { status?: number; message?: string }, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const status = err.status || 500;
    res
      .status(status)
      .type('application/problem+json')
      .json(buildProblem(status, err.message || 'An unexpected error occurred.', req.originalUrl));
  });

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
