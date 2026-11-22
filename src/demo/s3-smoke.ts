// npm run smoke:s3 — the object store, end to end, with the app's own S3 client and
// config (through the secrets store):
//
// put=200 head=200 anonymous-get=403 delete=204 head-after-delete=404
//
// One object under smoke/, put, read back, then fetched without any credentials (the
// bucket is private, so 403), deleted, and looked up again (404). The object is deleted
// in the cleanup too, whatever happens.
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { storageConfigOf, storageEnvShape, type StorageConfig } from '../config/storage.js';
import { createS3Client } from '../storage/s3-client.js';
import { log, runDemo, SetupError, statusContract } from './lib.js';

// The status of an SDK call, success or error alike (a 404 HEAD throws NotFound).
const statusOf = async (call: () => Promise<{ $metadata: { httpStatusCode?: number } }>): Promise<number> => {
  try {
    return (await call()).$metadata.httpStatusCode ?? 0;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === undefined) throw error; // no HTTP answer at all: DNS, refused, timeout
    log(`${(error as Error).name}: ${(error as Error).message}`);
    return status;
  }
};

// The object's plain URL, as a browser would ask for it: path style on an emulator,
// virtual-hosted on AWS.
const publicUrlOf = ({ endpoint, region, bucket }: StorageConfig, key: string): string =>
  endpoint ? `${endpoint.replace(/\/$/, '')}/${bucket}/${key}` : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

await runDemo('smoke:s3', async (onCleanup) => {
  const parsed = z.object(storageEnvShape).safeParse(process.env);
  if (!parsed.success) {
    throw new SetupError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  const storage = storageConfigOf(parsed.data);
  const s3: S3Client = createS3Client(storage);
  onCleanup(async () => s3.destroy());

  const key = `smoke/${randomUUID()}.txt`;
  const object = { Bucket: storage.bucket, Key: key };
  onCleanup(async () => {
    await s3.send(new DeleteObjectCommand(object)).catch(() => {});
  });
  const { step, held } = statusContract();
  log(`${storage.endpoint ?? 'AWS'} region=${storage.region} bucket=${storage.bucket} key=${key}`);

  step('put', await statusOf(() => s3.send(new PutObjectCommand({ ...object, Body: 'smoke', ContentType: 'text/plain' }))), 200);
  step('head', await statusOf(() => s3.send(new HeadObjectCommand(object))), 200);
  const anonymous = await fetch(publicUrlOf(storage, key));
  await anonymous.arrayBuffer();
  step('anonymous-get', anonymous.status, 403);
  step('delete', await statusOf(() => s3.send(new DeleteObjectCommand(object))), 204);
  step('head-after-delete', await statusOf(() => s3.send(new HeadObjectCommand(object))), 404);

  return held();
});
