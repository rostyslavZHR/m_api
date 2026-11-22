// npm run demo:cdn — the private bucket behind the edge (HW#26, criterion 5):
//
// direct=403 edge-miss=200 edge-hit=200 cache-hit=1 new-name=1 new-url=200 content-changed=1
//
//   The edge (dist/edge/main.js) runs as its own process on a free port, with only its own
//   settings and its read-only key in its environment. Version 1 of demo-cdn.css is
//   published the way a deploy does it (assets/demo-cdn.<hash>.css, immutable).
//   direct        an anonymous GET of it straight from the store: 403
//   edge-miss     the first GET through the edge: 200 (X-Cache: MISS)
//   edge-hit      the second: 200; cache-hit=1 if its X-Cache is HIT
//   new-name      version 2 (other content) gets another hashed name: 1
//   new-url       the new name through the edge: 200
//   content-changed  its body is version 2's: 1
//
// At the start and the end, every assets/demo-cdn.* object is removed, and the manifest's
// demo-cdn.css entry with them. The content is unique per run; only statuses and counts
// are printed.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { MANIFEST_CACHE_CONTROL, MANIFEST_KEY, publishAsset } from '../edge/publish.js';
import { clearPrefix, demoStorage, isListening } from './files-kit.js';
import { log, requireEnv, runDemo, SetupError, statusContract } from './lib.js';

const NAME = 'demo-cdn.css';
const PREFIX = 'assets/demo-cdn.';

// A port nothing listens on right now: the OS picks one for a moment.
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

// Removes every object this demo publishes, and its entry in the manifest.
async function unpublish(s3: S3Client, bucket: string): Promise<void> {
  await clearPrefix(s3, bucket, PREFIX);
  try {
    const current = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: MANIFEST_KEY }));
    const manifest = JSON.parse(await current.Body!.transformToString()) as Record<string, string>;
    if (!(NAME in manifest)) return;
    delete manifest[NAME];
    await s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: MANIFEST_KEY, Body: JSON.stringify(manifest, null, 2), ContentType: 'application/json', CacheControl: MANIFEST_CACHE_CONTROL }),
    );
  } catch (error) {
    if ((error as { name?: string }).name !== 'NoSuchKey') throw error;
  }
}

await runDemo('demo:cdn', async (onCleanup) => {
  const { storage, s3 } = demoStorage(onCleanup);
  if (!storage.endpoint) throw new SetupError('S3_ENDPOINT is required: the demo reads the store directly for direct=403');
  await unpublish(s3, storage.bucket);
  onCleanup(() => unpublish(s3, storage.bucket));

  // The edge, with exactly its own settings: the store's address and the edge's read-only key.
  const port = await freePort();
  const edge = spawn(process.execPath, [fileURLToPath(new URL('../edge/main.js', import.meta.url))], {
    env: {
      EDGE_PORT: String(port),
      S3_ENDPOINT: storage.endpoint,
      S3_REGION: storage.region,
      S3_BUCKET: storage.bucket,
      EDGE_S3_ACCESS_KEY_ID: requireEnv('EDGE_S3_ACCESS_KEY_ID'),
      EDGE_S3_SECRET_ACCESS_KEY: requireEnv('EDGE_S3_SECRET_ACCESS_KEY'),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  onCleanup(async () => {
    if (edge.exitCode === null && edge.signalCode === null) edge.kill('SIGTERM');
  });
  for (let i = 0; i < 50 && !(await isListening(port)); i++) await sleep(100);
  if (!(await isListening(port))) throw new SetupError(`the edge didn't start on port ${port}`);
  const viaEdge = async (key: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/${key}`);
    return { status: response.status, xCache: response.headers.get('x-cache'), body: await response.text() };
  };

  const run = randomUUID();
  const v1 = Buffer.from(`/* ${run} */ body { color: #111111; }\n`);
  const v2 = Buffer.from(`/* ${run} */ body { color: #222222; }\n`);
  const key1 = await publishAsset(s3, storage.bucket, NAME, v1);
  log(`published version 1: ${key1}`);
  const { step, held } = statusContract();

  // Straight from the store, anonymously: the bucket is private.
  const direct = await fetch(`${storage.endpoint.replace(/\/$/, '')}/${storage.bucket}/${key1}`);
  await direct.arrayBuffer();
  step('direct', direct.status, 403);

  const miss = await viaEdge(key1);
  step('edge-miss', miss.status, 200);
  const hit = await viaEdge(key1);
  step('edge-hit', hit.status, 200);
  log(`X-Cache: ${miss.xCache}, then ${hit.xCache}`);
  step('cache-hit', Number(hit.xCache === 'HIT'), 1);

  // A deploy of new content: a new name, nothing invalidated.
  const key2 = await publishAsset(s3, storage.bucket, NAME, v2);
  log(`published version 2: ${key2}`);
  step('new-name', Number(key2 !== key1), 1);
  const fresh = await viaEdge(key2);
  step('new-url', fresh.status, 200);
  step('content-changed', Number(fresh.body === v2.toString()), 1);

  return held();
});
