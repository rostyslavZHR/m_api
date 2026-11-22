// What the HW#26 demos (upload, multipart, cdn) share.
//
// A known state, at the start and at the end: every demo's users have an email prefix of
// their own (demo-upload-…, demo-multipart-…), and sweep() removes everything such users
// own: their unfinished multipart uploads, their objects under uploads/<id>/, their file
// rows, the users themselves. At the start it clears what a crashed run left behind (a
// SIGKILL skips every cleanup); at the end it clears this run.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { type StorageConfig, storageConfigOf, storageEnvShape } from '../config/storage.js';
import { createS3Client } from '../storage/s3-client.js';
import { log, SetupError } from './lib.js';

type OnCleanup = (fn: () => Promise<void>) => void;

// The app's storage settings and client (the vault's S3_* values).
export function demoStorage(onCleanup: OnCleanup): { storage: StorageConfig; s3: S3Client } {
  const parsed = z.object(storageEnvShape).safeParse(process.env);
  if (!parsed.success) throw new SetupError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const storage = storageConfigOf(parsed.data);
  const s3 = createS3Client(storage);
  onCleanup(async () => s3.destroy());
  return { storage, s3 };
}

// Everything under a prefix: unfinished multipart uploads aborted, objects deleted.
export async function clearPrefix(s3: S3Client, bucket: string, prefix: string): Promise<{ uploads: number; objects: number }> {
  let uploads = 0;
  let objects = 0;
  for (;;) {
    const page = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }));
    for (const upload of page.Uploads ?? []) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: upload.Key, UploadId: upload.UploadId })).catch(() => {});
      uploads++;
    }
    if (!page.IsTruncated) break;
  }
  for (;;) {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    const keys = (page.Contents ?? []).map(({ Key }) => ({ Key: Key! }));
    if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    objects += keys.length;
    if (!page.IsTruncated) break;
  }
  return { uploads, objects };
}

// Every user with this email prefix, and everything they own in the store and the database.
export async function sweep(admin: DataSource, s3: S3Client, bucket: string, emailPrefix: string): Promise<void> {
  const users = (await admin.query(`SELECT id FROM users WHERE email LIKE $1`, [`${emailPrefix}%`])) as { id: string }[];
  let uploads = 0;
  let objects = 0;
  for (const { id } of users) {
    const cleared = await clearPrefix(s3, bucket, `uploads/${id}/`);
    uploads += cleared.uploads;
    objects += cleared.objects;
  }
  if (users.length) {
    const ids = users.map(({ id }) => id);
    await admin.transaction(async (manager) => {
      await manager.query('DELETE FROM files WHERE owner_id = ANY($1::bigint[])', [ids]);
      await manager.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [ids]);
    });
  }
  if (users.length || uploads || objects) log(`sweep ${emailPrefix}*: ${users.length} users, ${objects} objects, ${uploads} unfinished uploads removed`);
}

export interface DemoUser {
  id: string;
  email: string;
  password: string;
}

// A customer who can log in, under the demo's prefix (so sweep() finds it).
export async function demoUser(admin: DataSource, emailPrefix: string): Promise<DemoUser> {
  const tag = randomUUID().slice(0, 8);
  const email = `${emailPrefix}${tag}@example.com`;
  const password = `demo-${tag}-password`;
  const [row] = (await admin.query(`INSERT INTO users (email, balance_cents, password_hash) VALUES ($1, 0, $2) RETURNING id`, [
    email,
    await hashPassword(password),
  ])) as { id: string }[];
  return { id: String(row.id), email, password };
}

// Is anything listening? A raw TCP connect, never fetch: fetch's connection pool can hand
// back a kept-alive socket to a server that's gone, and hang until a timeout.
export const isListening = (port: number, host = '127.0.0.1'): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });

// A tiny real PNG (1×1): enough for the magic-byte check in commit.
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// A child process running one of dist/demo/children/*.js with exactly `env` (nothing
// inherited), its stdout split into lines for the parent, its stderr passed through. Killed
// with SIGKILL in the cleanup if it's still running.
export interface Child {
  process: ChildProcess;
  lines: string[];
  // Resolves with the first stdout line that matches, or rejects if the child exits first.
  waitForLine(match: (line: string) => boolean, ms: number): Promise<string>;
  exited: Promise<number | null>;
}

export function startChild(script: string, env: Record<string, string>, onCleanup: OnCleanup): Child {
  const entry = fileURLToPath(new URL(`./children/${script}.js`, import.meta.url));
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  onCleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const lines: string[] = [];
  const listeners = new Set<() => void>();
  let buffered = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const parts = buffered.split('\n');
    buffered = parts.pop()!;
    lines.push(...parts);
    listeners.forEach((notify) => notify());
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      resolve(code);
      listeners.forEach((notify) => notify());
    }),
  );
  const waitForLine = (match: (line: string) => boolean, ms: number) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => finish(() => reject(new SetupError(`${script}: no expected line within ${ms} ms`))), ms);
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        listeners.delete(check);
        settle();
      };
      const check = () => {
        const line = lines.find(match);
        if (line !== undefined) finish(() => resolve(line));
        else if (child.exitCode !== null || child.signalCode !== null) finish(() => reject(new SetupError(`${script} exited before the expected line`)));
      };
      listeners.add(check);
      check();
    });
  return { process: child, lines, waitForLine, exited };
}
