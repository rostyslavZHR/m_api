import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
// The compiled schema (npm run check:env builds first): the source's relative
// imports end in .js, which Node can't resolve to .ts files.
import { apiEnvSchema } from '../dist/config/env.schema.js';

// The API's variables: the shared ones and the JWT keys.
const schemaKeys = Object.keys(apiEnvSchema.shape).sort();
const envExampleKeys = Object.keys(
  parse(readFileSync(new URL('../.env.example', import.meta.url))),
).sort();

const missingKeys = schemaKeys
  .filter((key) => !envExampleKeys.includes(key))
  .join(' ');
const extraKeys = envExampleKeys
  .filter((key) => !schemaKeys.includes(key))
  .join(' ');

if (missingKeys.length || extraKeys.length) {
  if (missingKeys.length)
    console.error(`.env.example is lacking following keys: ${missingKeys}`);
  if (extraKeys.length)
    console.error(`.env.example has following extra keys: ${extraKeys}`);

  process.exit(1);
}

console.log('.env.example keys validation succeeded');
