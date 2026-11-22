// Object storage (HW#26): an S3-compatible store. In dev, Garage in docker compose; in
// production, real S3 (or any S3-compatible service). The values come from the secrets
// store (.secrets/infisical.<env>.env, through scripts/with-secrets.sh), like the JWT
// keys, and are checked here at startup, before anything connects: a missing one stops
// the start with its name.
import { z } from 'zod';

// Empty means unset, as in .env.example.
const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

export const storageEnvShape = {
  // The store's base URL, e.g. http://127.0.0.1:21117 for the dev Garage. Unset (or
  // empty) means real AWS: the SDK builds the regional endpoint itself.
  S3_ENDPOINT: z.preprocess(emptyAsUnset, z.url({ protocol: /^https?$/ }).optional()),
  // Must be the store's own region, or every signature fails (SignatureDoesNotMatch,
  // which doesn't mention the region). Garage's is whatever s3_region says: "garage".
  S3_REGION: z.string({ error: 'required' }).min(1, 'required'),
  S3_ACCESS_KEY_ID: z.string({ error: 'required' }).min(1, 'required'),
  S3_SECRET_ACCESS_KEY: z.string({ error: 'required' }).min(1, 'required'),
  // S3's naming rules: 3–63 characters, lowercase letters, digits, dots and hyphens,
  // starting and ending with a letter or digit.
  S3_BUCKET: z
    .string({ error: 'required' })
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'expected an S3 bucket name (3–63 lowercase letters, digits, dots, hyphens)'),
};

export interface StorageConfig {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export const storageConfigOf = (env: {
  S3_ENDPOINT?: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_BUCKET: string;
}): StorageConfig => ({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  bucket: env.S3_BUCKET,
});
