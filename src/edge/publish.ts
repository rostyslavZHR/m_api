// npm run assets:publish -- <file> — the "deploy" of a static asset (#186): the content's
// hash goes into the name, and the object is stored with a year-long, immutable
// Cache-Control. New content → a new hash → a new key; the old object stays, and nothing is
// ever invalidated. Then the manifest (assets/manifest.json) is pointed at the new name:
// the one object that must stay short-lived (no-cache), since it's how a page finds out
// which name is current.
//
// app.css with content … → assets/app.<first 8 hex of its SHA-256>.css
//
// Runs with the app's key (it writes), through the secrets store. Prints the name it
// published to stdout.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { storageConfigOf, storageEnvShape } from '../config/storage.js';
import { createS3Client } from '../storage/s3-client.js';
import { ASSETS_PREFIX } from './asset-path.js';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const MANIFEST_KEY = `${ASSETS_PREFIX}manifest.json`;
// Cached, but revalidated before every use: a new deploy shows up on the next request.
export const MANIFEST_CACHE_CONTROL = 'no-cache';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

// From the content only: the same bytes always get the same name, so a redeploy of
// unchanged files keeps every cached copy valid. 8 hex digits (32 bits) is plenty to tell
// one file's versions apart.
export const contentHash = (content: Buffer): string => createHash('sha256').update(content).digest('hex').slice(0, 8);

export const hashedKeyOf = (fileName: string, content: Buffer): string => {
  const ext = extname(fileName);
  return `${ASSETS_PREFIX}${basename(fileName, ext)}.${contentHash(content)}${ext}`;
};

export async function publishAsset(s3: S3Client, bucket: string, fileName: string, content: Buffer): Promise<string> {
  const ext = extname(fileName);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) throw new Error(`no content type known for ${ext}`);
  const key = hashedKeyOf(fileName, content);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ContentType: contentType, CacheControl: IMMUTABLE }));

  // The manifest: the current name for each logical file. Read, update, write back.
  let manifest: Record<string, string> = {};
  try {
    const current = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: MANIFEST_KEY }));
    manifest = JSON.parse(await current.Body!.transformToString()) as Record<string, string>;
  } catch (error) {
    if ((error as { name?: string }).name !== 'NoSuchKey') throw error;
  }
  manifest[basename(fileName)] = `/${key}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: MANIFEST_KEY,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
      CacheControl: MANIFEST_CACHE_CONTROL,
    }),
  );
  return key;
}

// The CLI, when run as a script (not when imported by a demo).
if (process.argv[1]?.endsWith('/edge/publish.js')) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npm run assets:publish -- <file>');
    process.exit(1);
  }
  const parsedEnv = z.object(storageEnvShape).safeParse(process.env);
  if (!parsedEnv.success) {
    console.error(parsedEnv.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
    process.exit(1);
  }
  const storage = storageConfigOf(parsedEnv.data);
  const s3 = createS3Client(storage);
  try {
    const key = await publishAsset(s3, storage.bucket, basename(file), await readFile(file));
    console.log(key);
    console.error(`[publish] ${file} → ${key} (${IMMUTABLE}); ${MANIFEST_KEY} updated (${MANIFEST_CACHE_CONTROL})`);
  } finally {
    s3.destroy();
  }
}
