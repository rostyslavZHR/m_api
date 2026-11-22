// npm run demo:upload — the upload contract end to end (HW#26, criterion 3), through the
// real API (in this process, on random ports) and the store:
//
// intent=200 key-from-server=1 api-alive=0 put-offline=200 commit=200
// commit-without-bytes=409 tampered=403 expired=400
//
//   intent, key-from-server  intent with filename "../../etc/passwd": the key is the
//                            server's (uploads/<user>/<uuid>.png), nothing from the name
//   api-alive                the API stopped, checked with a raw socket (net.connect): 0
//   put-offline              the PUT, from a child process with no credentials at all
//   commit                   commit on a second API instance (a new port: fetch's pool
//                            could hold a dead socket for the old one)
//   commit-without-bytes     a second intent, commit with no PUT: 409
//   tampered                 a valid URL with another key in its path: 403
//   expired                  a URL signed for 2 s, used 2 s after it expired. The store's
//                            real status: 400 on Garage ("Date is too old"), 403 on AWS.
//                            Either is "refused for expiry"; see the README.
//
// Its users are demo-upload-*; sweep() clears them (users, rows, objects) at the start and
// at the end. No presigned URL is ever printed.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { presignPut } from '../storage/presign.js';
import { startApi } from './api.js';
import { http } from './auth-kit.js';
import { demoStorage, demoUser, isListening, PNG_1X1, startChild, sweep } from './files-kit.js';
import { log, migrate, runDemo, SetupError, statusContract } from './lib.js';

const PREFIX = 'demo-upload-';
const EXPIRES_S = 2;
const EXPIRY_MARGIN_MS = 2_000;

await runDemo('demo:upload', async (onCleanup) => {
  const admin = await migrate(onCleanup);
  const { storage, s3 } = demoStorage(onCleanup);
  await sweep(admin, s3, storage.bucket, PREFIX);
  onCleanup(() => sweep(admin, s3, storage.bucket, PREFIX));
  const user = await demoUser(admin, PREFIX);

  const dir = await mkdtemp(join(tmpdir(), 'demo-upload-'));
  onCleanup(() => rm(dir, { recursive: true, force: true }));
  const pngFile = join(dir, 'photo.png');
  await writeFile(pngFile, PNG_1X1);

  const first = await startApi(onCleanup);
  const login = await http(first.url)('POST', '/auth/login', { body: { email: user.email, password: user.password } });
  if (login.status !== 200) throw new SetupError(`login answered ${login.status}`);
  const token = String(login.body.accessToken);
  const { step, held } = statusContract();
  const intentBody = (filename: string) => ({ token, body: { filename, contentType: 'image/png', size: PNG_1X1.length } });

  // intent, with a hostile filename.
  const intent = await http(first.url)('POST', '/uploads/intent', intentBody('../../etc/passwd'));
  step('intent', intent.status, 200);
  if (intent.status !== 200) throw new SetupError('intent failed: nothing else to check');
  const key = String(intent.body.key);
  log(`file ${String(intent.body.fileId)} key ${key}`);
  const serverKey = new RegExp(`^uploads/${user.id}/[0-9a-f-]{36}\\.png$`).test(key) && !key.includes('passwd') && !key.includes('..');
  step('key-from-server', Number(serverKey), 1);

  // The API goes away; the upload doesn't need it.
  await first.stop();
  step('api-alive', Number(await isListening(first.port)), 0);

  // The PUT from a process with nothing but the URL: no credentials to fall back on.
  const child = startChild('put-offline', { PUT_URL: String(intent.body.uploadUrl), PUT_CONTENT_TYPE: 'image/png', PUT_FILE: pngFile }, onCleanup);
  const putLine = await child.waitForLine((line) => line.startsWith('status='), 15_000);
  step('put-offline', Number(putLine.split('=')[1]), 200);

  // A new API instance, on a new port.
  const second = await startApi(onCleanup);
  log(`API restarted on port ${second.port} (was ${first.port})`);
  const api = http(second.url);
  const commit = await api('POST', '/uploads/commit', { token, body: { fileId: intent.body.fileId } });
  step('commit', commit.status, 200);

  // Commit with no bytes behind it.
  const empty = await api('POST', '/uploads/intent', intentBody('empty.png'));
  const noBytes = await api('POST', '/uploads/commit', { token, body: { fileId: empty.body.fileId } });
  step('commit-without-bytes', noBytes.status, 409);

  // A valid URL with another key in its path: the signature covers the path.
  const tampered = new URL(String(empty.body.uploadUrl));
  tampered.pathname = tampered.pathname.replace(/[0-9a-f-]{36}\.png$/, `${randomUUID()}.png`);
  const tamperedPut = await fetch(tampered, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG_1X1 });
  await tamperedPut.arrayBuffer();
  step('tampered', tamperedPut.status, 403);

  // An expired URL, signed here for 2 s (the product's 300 s is untouched), used 2 s after
  // it expired. 400 (Garage) or 403 (AWS): both mean the store refused it for its age.
  const shortUrl = await presignPut(s3, {
    bucket: storage.bucket,
    key: `uploads/${user.id}/${randomUUID()}.png`,
    contentType: 'image/png',
    expiresIn: EXPIRES_S,
  });
  await sleep(EXPIRES_S * 1000 + EXPIRY_MARGIN_MS);
  const expired = await fetch(shortUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG_1X1 });
  await expired.arrayBuffer();
  step('expired', expired.status, 400, 403);

  return held();
});
