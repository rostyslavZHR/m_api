import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import pact from '@pact-foundation/pact';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../integration/testkit/app.js';
import { startTestDatabase } from '../integration/testkit/postgres.js';
import { PACT_FILE, PROVIDER } from './pact.js';

// Verifies the real app — container, migrations, configureApp — against the
// consumer's pact. A plain script rather than a Jest test: there's nothing to
// assert beyond the verifier's own result, which becomes the exit code.
const { Verifier } = pact;

const db = await startTestDatabase();
let app: NestExpressApplication | undefined;

try {
  app = await createTestApp(db);
  // Pact needs a real listening server; port 0 lets the OS pick a free one.
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;

  await new Verifier({
    provider: PROVIDER,
    providerBaseUrl: `http://127.0.0.1:${port}`,
    pactUrls: [PACT_FILE],
    // Each state starts from an empty database, so verification is repeatable
    // and a fixed id can't collide with the identity sequence.
    stateHandlers: {
      'product 42 exists': async () => {
        await db.reset();
        // id is GENERATED ALWAYS: an explicit id needs OVERRIDING SYSTEM VALUE.
        // Through db.app, so app_user's grants are exercised.
        await db.app.query(
          `INSERT INTO products (id, name, description, price_cents, stock)
           OVERRIDING SYSTEM VALUE VALUES (42, 'Mechanical Keyboard', 'Contract fixture', 8999, 5)`,
        );
      },
      'product 999 does not exist': async () => {
        await db.reset();
      },
    },
  }).verifyProvider();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await app?.close();
  await db.stop();
}
