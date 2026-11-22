// npm run edge — the local stand-in for CloudFront with OAC (#185): a small caching server
// in front of the private bucket, its own process on its own port (EDGE_PORT, 21120).
//
//   GET /assets/<name>  a fresh copy in the cache → served, X-Cache: HIT
//                       otherwise → GetObject with the edge's own read-only key, stored
//                       (body, Content-Type, Cache-Control, ETag) if the object's
//                       Cache-Control allows it, served, X-Cache: MISS
//   anything else       404: only assets/ is ever served here. uploads/ (private files) go
//                       through the API's GET /files/:id, never through this cache.
//
// The bucket itself stays private: an anonymous GET on the store gets 403, so this edge,
// holding credentials, is the only public way in. That's OAC's idea.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { createS3Client } from '../storage/s3-client.js';
import { assetKeyOf } from './asset-path.js';
import { type CachedObject, EdgeCache, freshnessOf, isFresh } from './cache.js';

const log = (message: string) => console.error(`[edge] ${message}`);

const MiB = 1024 * 1024;
// 64 MiB for the whole cache, 8 MiB per object: the edge holds CSS, JS and images, not
// videos, and one big object can't evict everything else.
const CACHE_BYTES = 64 * MiB;
const OBJECT_BYTES = 8 * MiB;
// A missing asset is remembered for 10 s: enough to absorb a burst of requests for a name
// that doesn't exist, short enough that publishing it shows up almost at once.
const MISSING_TTL_MS = 10_000;

// The edge's own settings, from the secrets store: the store's address and bucket (the
// app's), and the edge's own key, read-only on the bucket (garage/edge-key.sh).
const envSchema = z.object({
  EDGE_PORT: z.coerce.number().int().min(1).max(65535).default(21120),
  S3_ENDPOINT: z.preprocess((v) => (v === '' ? undefined : v), z.url({ protocol: /^https?$/ }).optional()),
  S3_REGION: z.string({ error: 'required' }).min(1, 'required'),
  S3_BUCKET: z.string({ error: 'required' }).min(1, 'required'),
  EDGE_S3_ACCESS_KEY_ID: z.string({ error: 'required' }).min(1, 'required'),
  EDGE_S3_SECRET_ACCESS_KEY: z.string({ error: 'required' }).min(1, 'required'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  log(`Invalid environment variables:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  process.exit(1);
}
const env = parsed.data;
const s3 = createS3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.EDGE_S3_ACCESS_KEY_ID,
  secretAccessKey: env.EDGE_S3_SECRET_ACCESS_KEY,
  bucket: env.S3_BUCKET,
});
const cache = new EdgeCache(CACHE_BYTES, OBJECT_BYTES);
const missing = new Map<string, number>(); // key → remembered until

const statusOf = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

function send(req: IncomingMessage, res: ServerResponse, object: CachedObject, xCache: string, now: number): void {
  const headers: Record<string, string | number> = {
    'Content-Type': object.contentType,
    'Cache-Control': object.cacheControl,
    'X-Cache': xCache,
    // How old the cached copy is, as a CDN reports it.
    Age: Math.max(0, Math.floor((now - object.storedAt) / 1000)),
  };
  if (object.etag) headers.ETag = object.etag;
  // The browser's own revalidation: same ETag → 304, no body.
  if (object.etag && req.headers['if-none-match'] === object.etag) {
    res.writeHead(304, headers).end();
    return;
  }
  headers['Content-Length'] = object.body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : object.body);
}

function notFound(res: ServerResponse, xCache?: string): void {
  res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', ...(xCache && { 'X-Cache': xCache }) }).end('Not found\n');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<string> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return '405';
  }
  const key = assetKeyOf(req.url ?? '/');
  if (!key) {
    notFound(res);
    return '404 (outside assets/)';
  }
  const now = Date.now();
  if ((missing.get(key) ?? 0) > now) {
    notFound(res, 'HIT');
    return '404 HIT (missing)';
  }

  const cached = cache.get(key);
  if (cached && isFresh(cached, now)) {
    send(req, res, cached, 'HIT', now);
    return 'HIT';
  }

  // A miss, or a stale copy: ask the store. With a stale copy, ask conditionally: an
  // unchanged object answers 304 and the copy is fresh again (a "refresh hit").
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, IfNoneMatch: cached?.etag }));
    const entry: CachedObject = {
      body: Buffer.from(await object.Body!.transformToByteArray()),
      contentType: object.ContentType ?? 'application/octet-stream',
      cacheControl: object.CacheControl ?? '',
      etag: object.ETag,
      storedAt: now,
      maxAgeMs: 0,
    };
    const freshness = freshnessOf(object.CacheControl);
    if (freshness.cacheable) cache.set(key, { ...entry, maxAgeMs: freshness.maxAgeMs });
    else cache.delete(key);
    missing.delete(key);
    send(req, res, entry, 'MISS', now);
    return `MISS (${freshness.cacheable ? `cached ${freshness.maxAgeMs / 1000} s` : 'not cacheable'})`;
  } catch (error) {
    const status = statusOf(error);
    if (status === 304 && cached) {
      cached.storedAt = now;
      send(req, res, cached, 'REVALIDATED', now);
      return 'REVALIDATED';
    }
    if (status === 404) {
      cache.delete(key);
      missing.set(key, now + MISSING_TTL_MS);
      if (missing.size > 10_000) missing.delete(missing.keys().next().value!);
      notFound(res, 'MISS');
      return '404 MISS';
    }
    log(`origin error for ${key}: ${(error as Error).name}: ${(error as Error).message}`);
    res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Bad gateway\n');
    return '502';
  }
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  handle(req, res).then(
    (outcome) => log(`${req.method} ${path} → ${outcome}`),
    (error: Error) => {
      log(`${req.method} ${path} failed: ${error.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    },
  );
});

server.listen(env.EDGE_PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${env.EDGE_PORT}, bucket ${env.S3_BUCKET}`));

const shutdown = (signal: string) => {
  log(`${signal}: stopping`);
  server.close(() => {
    s3.destroy();
    process.exit(0);
  });
  server.closeAllConnections();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
