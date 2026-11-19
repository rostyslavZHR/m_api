// npm run demo:session — a session through the real API (in this process, on a
// random port): one login, then requests with its cookie, the last one after a
// pause, so the session's TTL has dropped and the request visibly renews it.
//
// requests=3 sessions=1 in-redis=1 ttl-renewed=1
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeRedis, createSessionClient } from '../redis/redis-clients.js';
import { SESSION_COOKIE } from '../sessions/session.middleware.js';
import { startApi } from './api.js';
import { checker, connected, log, migrate, printResults, requireEnv, runDemo } from './lib.js';
import { openAppDb } from './run.js';

const REQUESTS = 3;
// Before the last request: long enough for the TTL (whole seconds) to drop.
const PAUSE_MS = 1_500;

// The session ids a response hands out, from its Set-Cookie headers.
const sessionIdsOf = (response: Response): string[] =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .filter((pair) => pair.startsWith(`${SESSION_COOKIE}=`) && pair.length > SESSION_COOKIE.length + 1)
    .map((pair) => pair.slice(SESSION_COOKIE.length + 1));

await runDemo('demo:session', async (onCleanup) => {
  await migrate(onCleanup);
  const db = await openAppDb();
  onCleanup(() => db.destroy());
  // The queue instance, where sessions live: to read the key's TTL from outside.
  const redis = createSessionClient(requireEnv('REDIS_QUEUE_URL'));
  onCleanup(() => closeRedis(redis));
  await connected(redis);

  const [user] = (await db.query(`INSERT INTO users (email, balance_cents) VALUES ($1, 0) RETURNING id`, [
    `demo-session-${randomUUID().slice(0, 8)}@example.com`,
  ])) as { id: string }[];
  onCleanup(async () => {
    await db.query('DELETE FROM users WHERE id = $1', [user.id]);
  });

  const { url } = await startApi(onCleanup);

  // Log in: the session id comes back only in the cookie.
  const login = await fetch(`${url}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(user.id) }),
  });
  if (login.status !== 201) throw new Error(`POST /sessions answered ${login.status}`);
  const seen = new Set(sessionIdsOf(login));
  const [sid] = seen;
  const key = `sess:${sid}`;
  onCleanup(async () => {
    await redis.del(key);
  });
  log(`user ${user.id}, session ${sid.slice(0, 8)}…`);

  // Requests with the cookie; the last one after a pause, between two TTL readings.
  const statuses: number[] = [];
  let ttlBefore = -1;
  let ttlAfter = -1;
  for (let i = 1; i <= REQUESTS; i++) {
    if (i === REQUESTS) {
      await sleep(PAUSE_MS);
      ttlBefore = await redis.ttl(key);
    }
    const response = await fetch(`${url}/session`, { headers: { Cookie: `${SESSION_COOKIE}=${sid}` } });
    await response.arrayBuffer();
    statuses.push(response.status);
    for (const id of sessionIdsOf(response)) seen.add(id);
    if (i === REQUESTS) ttlAfter = await redis.ttl(key);
  }
  const inRedis = await redis.exists(key);
  log(`statuses ${statuses.join(' ')}; TTL ${ttlBefore} before the last request, ${ttlAfter} after`);

  printResults([
    ['requests', statuses.length],
    ['sessions', seen.size],
    ['in-redis', inRedis],
    ['ttl-renewed', ttlAfter > ttlBefore ? 1 : 0],
  ]);

  const { check, passed } = checker();
  check(`requests=${statuses.length} >= 3, all 200`, statuses.length >= 3 && statuses.every((s) => s === 200));
  check(`sessions=${seen.size}, expected 1`, seen.size === 1);
  check(`in-redis=${inRedis}, expected 1`, inRedis === 1);
  check(`ttl-renewed: ${ttlAfter} > ${ttlBefore}`, ttlAfter > ttlBefore);
  return passed();
});
