// npm run proof:presign — what the store itself enforces on a presigned URL (#181, #182),
// with the app's own client and signing code, against the store from the secrets store:
//
// within-window=200 expired=400 tampered-key=403 raised-expiry=403 reordered=200
//
// expired is 400 on Garage ("InvalidRequest: Date is too old") and 403 on AWS
// ("AccessDenied: Request has expired"): either is the store refusing the URL, and the
// real status is printed, not rewritten.
//
//   within-window, expired  one PUT URL signed for 2 s: used at once, then 2 s past its
//                           expiry (a margin, so the store's clock check can't flap)
//   tampered-key            a valid URL with another key in its path
//   raised-expiry           a valid URL with X-Amz-Expires raised
//   reordered               the control: the same query parameters in another order
//                           still work, since the signature is over a canonical (sorted)
//                           form, so "tampering" by reordering proves nothing
//
// The product expiry (300 s) is untouched: the proof passes its own to presignPut.
// Everything it writes is under proofs/<run>/ and deleted at the end.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { storageConfigOf, storageEnvShape } from '../config/storage.js';
import { createS3Client } from '../storage/s3-client.js';
import { presignPut } from '../storage/presign.js';
import { log, runDemo, SetupError, statusContract } from './lib.js';

const SHORT_EXPIRY_S = 2;
const MARGIN_MS = 2_000;
const CONTENT_TYPE = 'text/plain';

// A PUT with the signed Content-Type; the store's error code (from its XML body) to stderr.
async function put(url: string): Promise<number> {
  const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': CONTENT_TYPE }, body: 'proof' });
  const body = await response.text();
  if (response.status !== 200) log(`  ${response.status} ${/<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? body.slice(0, 80)}`);
  return response.status;
}

await runDemo('proof:presign', async (onCleanup) => {
  const parsed = z.object(storageEnvShape).safeParse(process.env);
  if (!parsed.success) throw new SetupError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const storage = storageConfigOf(parsed.data);
  const s3 = createS3Client(storage);
  onCleanup(async () => s3.destroy());

  const run = `proofs/${randomUUID()}`;
  const keys: string[] = [];
  const sign = (name: string, expiresIn: number) => {
    keys.push(`${run}/${name}`);
    return presignPut(s3, { bucket: storage.bucket, key: `${run}/${name}`, contentType: CONTENT_TYPE, expiresIn });
  };
  onCleanup(async () => {
    for (const key of keys) await s3.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key })).catch(() => {});
  });
  const { step, held } = statusContract();

  // Expiry: the same URL, inside and well past its window.
  const short = await sign('short.txt', SHORT_EXPIRY_S);
  step('within-window', await put(short), 200);
  await sleep(SHORT_EXPIRY_S * 1000 + MARGIN_MS);
  step('expired', await put(short), 400, 403);

  // Tampering: a valid 300 s URL, edited.
  const valid = new URL(await sign('valid.txt', 300));
  const otherKey = new URL(valid);
  otherKey.pathname = valid.pathname.replace('valid.txt', `${randomUUID()}.txt`);
  keys.push(`${run}/${otherKey.pathname.split('/').pop()}`);
  step('tampered-key', await put(otherKey.toString()), 403);

  const longer = new URL(valid);
  longer.searchParams.set('X-Amz-Expires', '604800');
  step('raised-expiry', await put(longer.toString()), 403);

  const reordered = new URL(valid);
  reordered.search = `?${[...valid.searchParams].reverse().map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
  step('reordered', await put(reordered.toString()), 200);

  return held();
});
