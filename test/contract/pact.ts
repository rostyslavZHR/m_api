import path from 'node:path';

// Fixed names: the pact file, the verifier, and later the broker and
// can-i-deploy must all use exactly these.
export const CONSUMER = 'web-app';
export const PROVIDER = 'm-api';

export const PACT_DIR = path.resolve('pacts');
export const PACT_FILE = path.join(PACT_DIR, `${CONSUMER}-${PROVIDER}.json`);
