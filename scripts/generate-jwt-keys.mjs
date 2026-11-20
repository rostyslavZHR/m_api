// A fresh JWT key set for one environment, as KEY=value lines for its secrets store:
//   node scripts/generate-jwt-keys.mjs dev >> .secrets/infisical.dev.env
// Redirect it straight into the store: the private key must never land in a log, a
// terminal scrollback or a tracked file.
//
// ES256: an EC key pair on P-256; both keys as base64 of their PEM (a multiline PEM
// doesn't survive an export). The kid is <env>-<yyyy>-<mm>, so a rotated key gets a
// new id. The pepper: 32 random bytes, base64url.
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const env = process.argv[2];
if (!/^[a-z]+$/.test(env ?? '')) {
  console.error('usage: node scripts/generate-jwt-keys.mjs <env>   (dev, prod, …)');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const base64 = (pem) => Buffer.from(pem).toString('base64');
const now = new Date();
const kid = `${env}-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

process.stdout.write(
  [
    `JWT_PRIVATE_KEY=${base64(privateKey.export({ type: 'pkcs8', format: 'pem' }))}`,
    `JWT_PUBLIC_KEY=${base64(publicKey.export({ type: 'spki', format: 'pem' }))}`,
    `JWT_KID=${kid}`,
    `REFRESH_TOKEN_PEPPER=${randomBytes(32).toString('base64url')}`,
  ].join('\n') + '\n',
);
