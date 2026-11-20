// The JWT signing keys and the refresh-token pepper, validated and decoded once, at
// startup. Each value arrives from the vault as base64 of a PEM (a multiline PEM
// doesn't survive an export); here it becomes a KeyObject, so a bad value fails at
// startup with the variable's name, never at the first login. No defaults: a default
// would be a key in the code.
import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign, verify } from 'node:crypto';
import { z } from 'zod';

// ES256: ECDSA on P-256 with SHA-256. Every key must be an 'ec' key on that curve.
export const JWT_ALG = 'ES256';
const KEY_TYPE = 'ec';
const CURVE = 'prime256v1'; // P-256, as OpenSSL names it

// What's inside a value that isn't a key: never its contents.
const notAKey = (kind: string) => `not a base64-encoded PEM ${kind} key`;

const pemKey = (kind: 'private' | 'public') =>
  z.string({ error: 'required' }).min(1, 'required').transform((value, ctx): KeyObject => {
    try {
      const pem = Buffer.from(value, 'base64').toString('utf8');
      if (!pem.includes(`-----BEGIN ${kind === 'public' ? 'PUBLIC KEY' : 'PRIVATE KEY'}-----`)) throw new Error();
      return kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
    } catch {
      ctx.addIssue({ code: 'custom', message: notAKey(kind) });
      return z.NEVER;
    }
  });

export const jwtEnvShape = {
  JWT_PRIVATE_KEY: pemKey('private'),
  JWT_PUBLIC_KEY: pemKey('public'),
  // <env>-<yyyy>-<mm>, e.g. dev-2026-11: a rotated key gets a new id.
  JWT_KID: z.string({ error: 'required' }).regex(/^[a-z]+-\d{4}-\d{2}$/, 'expected <env>-<yyyy>-<mm>, e.g. dev-2026-11'),
  // Mixed into every refresh-token hash; at least 32 characters (24+ random bytes).
  REFRESH_TOKEN_PEPPER: z.string({ error: 'required' }).min(32, 'too short: at least 32 characters'),
};

interface JwtKeys {
  JWT_PRIVATE_KEY: KeyObject;
  JWT_PUBLIC_KEY: KeyObject;
}

// The pair must be ES256 keys, and must belong together: sign a test string with the
// private key and verify it with the public one. Without this, an RSA key, or the
// prod private key next to the dev public key, would fail at the first signing.
export function checkJwtKeys(env: JwtKeys, ctx: z.RefinementCtx): void {
  for (const name of ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY'] as const) {
    const key = env[name];
    if (key.asymmetricKeyType !== KEY_TYPE || key.asymmetricKeyDetails?.namedCurve !== CURVE) {
      ctx.addIssue({ code: 'custom', path: [name], message: `not an ${JWT_ALG} key (expected EC on P-256)` });
      return;
    }
  }
  const probe = Buffer.from('jwt key self-test');
  const signature = sign('sha256', probe, env.JWT_PRIVATE_KEY);
  if (!verify('sha256', probe, env.JWT_PUBLIC_KEY, signature)) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_PUBLIC_KEY'],
      message: 'does not match JWT_PRIVATE_KEY (the self-test signature did not verify)',
    });
  }
}

// The SHA-256 of the public key as SPKI DER: identifies the key in logs and the
// README without showing it. The same value as
//   base64 -d <<<"$JWT_PUBLIC_KEY" | openssl pkey -pubin -outform DER | shasum -a 256
export const keyFingerprint = (publicKey: KeyObject): string =>
  `sha256:${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
