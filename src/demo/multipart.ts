// npm run demo:multipart — a crashed multipart upload, resumed (HW#26, criterion 4),
// through the real API (in this process, on a random port) and the store:
//
// head-before-complete=404 resumed-parts=1 complete=200 size-match=1 etag-multipart=1
//
//   An 11 MiB file → intent → 3 parts of 5 + 5 + 1 MiB. A child process uploads parts 1
//   and 2, says so, and is SIGKILLed (a crash: its own cleanup can't run).
//   head-before-complete  HeadObject now: no object exists until Complete (404)
//   resumed-parts         a new child asks GET /uploads/:id/parts (the store's ListParts)
//                         and uploads only what's missing, counting what it sent: 1
//   complete              commit: the server lists the parts itself and completes
//   size-match            the object's size equals the file's
//   etag-multipart        its ETag ends with -3 (parts) and isn't the file's MD5
//
// Its users are demo-multipart-*; sweep() clears them at the start and the end: their
// unfinished uploads aborted, their objects and rows deleted. So a second run starts from
// the same state, even after a crash of this demo itself.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { startApi } from './api.js';
import { http } from './auth-kit.js';
import { demoStorage, demoUser, PNG_1X1, startChild, sweep } from './files-kit.js';
import { log, migrate, runDemo, SetupError, statusContract } from './lib.js';

const PREFIX = 'demo-multipart-';
// A fixed size, so every run makes the same 3 parts; random content (only statuses and
// counts are printed). It starts with a real PNG, so commit's magic-byte check passes.
const FILE_BYTES = 11 * 1024 * 1024;
const PARTS_BEFORE_CRASH = 2;

await runDemo('demo:multipart', async (onCleanup) => {
  const admin = await migrate(onCleanup);
  const { storage, s3 } = demoStorage(onCleanup);
  await sweep(admin, s3, storage.bucket, PREFIX);
  onCleanup(() => sweep(admin, s3, storage.bucket, PREFIX));
  const user = await demoUser(admin, PREFIX);

  const dir = await mkdtemp(join(tmpdir(), 'demo-multipart-'));
  onCleanup(() => rm(dir, { recursive: true, force: true }));
  const data = randomBytes(FILE_BYTES);
  PNG_1X1.copy(data, 0);
  const dataFile = join(dir, 'big.png');
  await writeFile(dataFile, data);

  const api = await startApi(onCleanup);
  const call = http(api.url);
  const login = await call('POST', '/auth/login', { body: { email: user.email, password: user.password } });
  if (login.status !== 200) throw new SetupError(`login answered ${login.status}`);
  const token = String(login.body.accessToken);

  const intent = await call('POST', '/uploads/intent', { token, body: { filename: 'big.png', contentType: 'image/png', size: FILE_BYTES } });
  if (intent.status !== 200 || intent.body.kind !== 'multipart') throw new SetupError(`intent answered ${intent.status} (${String(intent.body.kind)})`);
  const { fileId, key, partSize, partCount } = intent.body as { fileId: string; key: string; partSize: number; partCount: number };
  log(`file ${fileId} key ${key}: ${partCount} parts of ${partSize} B`);
  // The part URLs go to the child in a file in this run's private temp directory (they
  // are bearer tokens: never in argv, never printed), deleted at the end.
  const partsFile = join(dir, 'parts.json');
  await writeFile(partsFile, JSON.stringify({ partSize, parts: intent.body.parts }), { mode: 0o600 });

  // The crash: wait for the child's own "part 2 done" line, then SIGKILL it.
  const uploader = startChild('multipart-upload', { PARTS_FILE: partsFile, DATA_FILE: dataFile, STOP_AFTER: String(PARTS_BEFORE_CRASH) }, onCleanup);
  await uploader.waitForLine((line) => line === `part ${PARTS_BEFORE_CRASH} done`, 60_000);
  uploader.process.kill('SIGKILL');
  await uploader.exited;
  log(`uploader killed after: ${uploader.lines.filter((l) => l.endsWith(' done')).join(', ')}`);

  const { step, held } = statusContract();
  const head = () => s3.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key }));
  const headBefore = await head().then(
    (h) => h.$metadata.httpStatusCode ?? 0,
    (error: { $metadata?: { httpStatusCode?: number } }) => error.$metadata?.httpStatusCode ?? 0,
  );
  step('head-before-complete', headBefore, 404);

  // A new process resumes: only what the store doesn't have.
  const resumer = startChild('multipart-resume', { API_URL: api.url, TOKEN: token, FILE_ID: fileId, DATA_FILE: dataFile }, onCleanup);
  const sentLine = await resumer.waitForLine((line) => line.startsWith('sent='), 60_000);
  step('resumed-parts', Number(sentLine.split('=')[1]), 1);

  const commit = await call('POST', '/uploads/commit', { token, body: { fileId } });
  step('complete', commit.status, 200);

  const object = await head().catch(() => undefined);
  step('size-match', Number(object?.ContentLength === FILE_BYTES), 1);
  const etag = (object?.ETag ?? '').replaceAll('"', '');
  const md5 = createHash('md5').update(data).digest('hex');
  log(`ETag ${etag}, the file's MD5 ${md5}`);
  step('etag-multipart', Number(etag.endsWith(`-${partCount}`) && etag !== md5), 1);

  return held();
});
