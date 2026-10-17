import path from 'node:path';
import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { buildProblem } from './common/problem.js';
import { ProblemExceptionFilter } from './common/problem-exception.filter.js';

// Shared by main.ts and the E2E tests, so the tests check the app production runs.
export const appOptions: NestApplicationOptions = {
  // configureApp installs its own JSON parser, ahead of the validator.
  bodyParser: false,
};

// From the working directory, like the password file: this file compiles to
// different depths under dist/ and dist-test/.
const OPENAPI_SPEC = path.resolve('openapi/openapi.yaml');

export function configureApp(app: NestExpressApplication): NestExpressApplication {
  app.use(express.json());

  app.use(
    OpenApiValidator.middleware({
      apiSpec: OPENAPI_SPEC,
      validateRequests: true,
      validateResponses: true,
      ignorePaths: /^\/(health|db)(\/|$)/,
    }),
  );

  app.useGlobalFilters(new ProblemExceptionFilter());

  // express-openapi-validator runs as raw Express middleware, ahead of Nest's
  // router, so its errors never reach ProblemExceptionFilter. This handles them.
  app.use((err: { status?: number; message?: string }, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.status || 500;
    res
      .status(status)
      .type('application/problem+json')
      .json(buildProblem(status, err.message || 'An unexpected error occurred.', req.originalUrl));
  });

  return app;
}
