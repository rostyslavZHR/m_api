import 'reflect-metadata';
import { execSync } from 'node:child_process';
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

const git = (args: string) => execSync(`git ${args}`, { encoding: 'utf8' }).trim();

// With PACT_BROKER_URL set (vault, CI, or exported), pacts come from the broker
// and the result is published under this version. Without it, the local file.
const brokerUrl = process.env.PACT_BROKER_URL;
const providerVersion = process.env.PROVIDER_VERSION ?? git('rev-parse --short HEAD');
const source = brokerUrl
  ? {
      pactBrokerUrl: brokerUrl,
      ...(process.env.PACT_BROKER_TOKEN ? { pactBrokerToken: process.env.PACT_BROKER_TOKEN } : {}),
      // The brief publishes with a plain curl PUT, which carries no branch, so
      // branch-based selectors would find nothing. Once publishing records a
      // branch (CI does), use { mainBranch: true } and { deployedOrReleased: true }.
      consumerVersionSelectors: [{ latest: true }],
      publishVerificationResult: true,
      providerVersion,
      providerVersionBranch: process.env.PROVIDER_BRANCH ?? git('rev-parse --abbrev-ref HEAD'),
    }
  : { pactUrls: [PACT_FILE] };

console.log(brokerUrl ? `Verifying from ${brokerUrl} as ${PROVIDER} version ${providerVersion}` : `Verifying ${PACT_FILE}`);

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
    ...source,
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
