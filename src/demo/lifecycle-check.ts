// npm run storage:lifecycle — sets the bucket's lifecycle rule (what the API does at every
// start) and reads it back from the store, to prove it's there:
//
// abort-incomplete-days=7 rule-enabled=1
import { z } from 'zod';
import { storageConfigOf, storageEnvShape } from '../config/storage.js';
import { applyLifecycle, readAbortRule } from '../storage/lifecycle.js';
import { createS3Client } from '../storage/s3-client.js';
import { runDemo, SetupError, statusContract } from './lib.js';

await runDemo('storage:lifecycle', async (onCleanup) => {
  const parsed = z.object(storageEnvShape).safeParse(process.env);
  if (!parsed.success) throw new SetupError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const storage = storageConfigOf(parsed.data);
  const s3 = createS3Client(storage);
  onCleanup(async () => s3.destroy());

  await applyLifecycle(s3, storage.bucket);
  const rule = await readAbortRule(s3, storage.bucket);
  const { step, held } = statusContract();
  step('abort-incomplete-days', rule?.days ?? 0, 7);
  step('rule-enabled', Number(rule?.status === 'Enabled'), 1);
  return held();
});
