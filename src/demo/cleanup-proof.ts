// npm run proof:cleanup — the abandoned-upload cleanup (src/uploads/abandoned-uploads.ts)
// against the real database and store, with rows and objects made for this run:
//
// found=3 removed=2 completed-meanwhile=1 abandoned-rows-left=0 abandoned-objects-left=0
// completed-untouched=1 committed-during-job-kept=1 recent-pending-kept=1
//
//   abandoned (×2)   PENDING, 25 h old, one with an object and one without: both removed
//   completed        COMPLETED, 25 h old, with its object: untouched
//   recent           PENDING, 1 minute old: below the threshold, untouched
//   racer            PENDING, 25 h old, with an object: the cleanup reads it, then a commit
//                    completes it, then the cleanup's delete runs. It must survive, and so
//                    must its object (the conditional delete).
//
// Only this run's rows are handed to the removal step, so other PENDING rows in the dev
// database never change the numbers. Everything is deleted at the end.
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { storageConfigOf, storageEnvShape } from '../config/storage.js';
import { createS3Client } from '../storage/s3-client.js';
import { findAbandoned, removeAbandoned } from '../uploads/abandoned-uploads.js';
import { FilesRepository } from '../uploads/files.repository.js';
import { log, migrate, runDemo, SetupError, statusContract } from './lib.js';

await runDemo('proof:cleanup', async (onCleanup) => {
  const parsed = z.object(storageEnvShape).safeParse(process.env);
  if (!parsed.success) throw new SetupError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const storage = storageConfigOf(parsed.data);
  const s3 = createS3Client(storage);
  onCleanup(async () => s3.destroy());
  const admin = await migrate(onCleanup);
  const files = new FilesRepository(admin.manager);

  // A user to own the rows; removed at the end with everything it owns.
  const [{ id: ownerId }] = (await admin.query(`INSERT INTO users (email, balance_cents) VALUES ($1, 0) RETURNING id`, [
    `demo-cleanup-${randomUUID().slice(0, 8)}@example.com`,
  ])) as { id: string }[];
  const made: { id: string; key: string }[] = [];
  onCleanup(async () => {
    for (const { key } of made) await s3.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key })).catch(() => {});
    await admin.query('DELETE FROM files WHERE owner_id = $1', [ownerId]);
    await admin.query('DELETE FROM users WHERE id = $1', [ownerId]);
  });

  const objectExists = (key: string) =>
    s3.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key })).then(
      () => true,
      () => false,
    );
  const aFile = async ({ status, ageMs, withObject }: { status: 'PENDING' | 'COMPLETED'; ageMs: number; withObject: boolean }) => {
    const id = randomUUID();
    const key = `uploads/${ownerId}/${id}.txt`;
    await files.insert({ id, key, ownerId, contentType: 'text/plain', size: 5 });
    await admin.query(`UPDATE files SET status = $2, created_at = now() - make_interval(secs => $3) WHERE id = $1`, [id, status, ageMs / 1000]);
    if (withObject) await s3.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: 'bytes' }));
    made.push({ id, key });
    return { id, key };
  };

  const DAY_AND_HOUR = 25 * 3600 * 1000;
  const abandoned = [await aFile({ status: 'PENDING', ageMs: DAY_AND_HOUR, withObject: true }), await aFile({ status: 'PENDING', ageMs: DAY_AND_HOUR, withObject: false })];
  const completed = await aFile({ status: 'COMPLETED', ageMs: DAY_AND_HOUR, withObject: true });
  const recent = await aFile({ status: 'PENDING', ageMs: 60_000, withObject: false });
  const racer = await aFile({ status: 'PENDING', ageMs: DAY_AND_HOUR, withObject: true });
  const ours = new Set(made.map(({ id }) => id));

  // Step 1, the job's read.
  const found = (await findAbandoned(files)).filter(({ id }) => ours.has(id));
  // A commit lands between the read and the delete.
  await admin.query(`UPDATE files SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [racer.id]);
  // Step 2, the job's delete.
  const result = await removeAbandoned({ files, s3, bucket: storage.bucket, log }, found);

  const rowStatus = async (id: string) => (await files.findById(id))?.status ?? 'gone';
  const { step, held } = statusContract();
  step('found', found.length, 3);
  step('removed', result.removed, 2);
  step('completed-meanwhile', result.completedMeanwhile, 1);
  step('abandoned-rows-left', (await Promise.all(abandoned.map(({ id }) => files.findById(id)))).filter(Boolean).length, 0);
  step('abandoned-objects-left', (await Promise.all(abandoned.map(({ key }) => objectExists(key)))).filter(Boolean).length, 0);
  step('completed-untouched', Number((await rowStatus(completed.id)) === 'COMPLETED' && (await objectExists(completed.key))), 1);
  step('committed-during-job-kept', Number((await rowStatus(racer.id)) === 'COMPLETED' && (await objectExists(racer.key))), 1);
  step('recent-pending-kept', Number((await rowStatus(recent.id)) === 'PENDING'), 1);
  return held();
});
