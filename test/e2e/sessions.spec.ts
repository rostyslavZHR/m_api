// Sessions through the HTTP API: the cookie, the middleware's renewal on every
// request, and two app instances sharing one Redis (configured like redis-queue).
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { UserEntity } from '../../src/entities/index.js';
import { createTestApp } from '../integration/testkit/app.js';
import { aUser } from '../integration/testkit/builders.js';
import { startTestDatabase, type TestDatabase } from '../integration/testkit/postgres.js';
import { startTestQueue, type TestRedis } from '../integration/testkit/redis.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Sessions API (e2e)', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: NestExpressApplication;
  let secondApp: NestExpressApplication;
  let userId: number;

  const sessionKeys = async () => (await redis.cli('--scan', '--pattern', 'sess:*')).split('\n').filter(Boolean);

  // POST /sessions; returns the "sid=…" pair to send back as the Cookie header.
  const login = async (on = app) => {
    const response = await request(on.getHttpServer()).post('/sessions').send({ user_id: userId }).expect(201);
    const setCookie = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
    return { cookie: setCookie[0].split(';')[0], setCookie: setCookie[0], body: response.body as Record<string, unknown> };
  };

  beforeAll(async () => {
    [db, redis] = await Promise.all([startTestDatabase(), startTestQueue()]);
    app = await createTestApp(db, { REDIS_QUEUE_URL: redis.url });
    secondApp = await createTestApp(db, { REDIS_QUEUE_URL: redis.url });
  });

  beforeEach(async () => {
    await db.reset();
    await redis.cli('FLUSHALL');
    userId = Number((await aUser().insertVia(db.app.getRepository(UserEntity))).id);
  });

  afterAll(async () => {
    await Promise.all([app?.close(), secondApp?.close()]);
    await Promise.all([db?.stop(), redis?.stop()]);
  });

  it('sets an HttpOnly, SameSite=Lax cookie and keeps one session across requests', async () => {
    const { cookie, setCookie, body } = await login();

    expect(setCookie).toMatch(/^sid=[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/; Expires=.+; HttpOnly; SameSite=Lax$/);
    expect(body).toMatchObject({ user_id: userId, idle_ttl_seconds: 1800 });
    for (let i = 0; i < 3; i++) {
      const response = await request(app.getHttpServer()).get('/session').set('Cookie', cookie).expect(200);
      expect(response.body).toEqual(body);
    }
    expect(await sessionKeys()).toHaveLength(1);
  });

  it('any request with the cookie pushes the TTL back up', async () => {
    const { cookie } = await login();
    const key = (await sessionKeys())[0];

    await sleep(2_100);
    const before = Number(await redis.cli('TTL', key));
    await request(app.getHttpServer()).get('/products').set('Cookie', cookie).expect(200);
    const after = Number(await redis.cli('TTL', key));

    expect(before).toBeLessThanOrEqual(1798);
    expect(after).toBe(1800);
  });

  it('anonymous requests create no session keys', async () => {
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer()).get('/session').expect(401);
      await request(app.getHttpServer()).get('/products').expect(200);
    }

    expect(await sessionKeys()).toEqual([]);
  });

  it('a second app instance on the same Redis reads the same session', async () => {
    const { cookie, body } = await login(app);

    const response = await request(secondApp.getHttpServer()).get('/session').set('Cookie', cookie).expect(200);

    expect(response.body).toEqual(body);
  });

  it('a session that is gone → 401 and the cookie is cleared', async () => {
    const { cookie } = await login();
    await redis.cli('FLUSHALL');

    const response = await request(app.getHttpServer()).get('/session').set('Cookie', cookie).expect(401);

    expect(response.body).toMatchObject({ type: 'https://example.com/problems/unauthorized', status: 401 });
    expect(String(response.headers['set-cookie'])).toMatch(/^sid=; Path=\/; Expires=Thu, 01 Jan 1970/);
  });

  it('logging in again replaces the session (a new id, the old one ends)', async () => {
    const first = await login();

    const second = await request(app.getHttpServer())
      .post('/sessions')
      .set('Cookie', first.cookie)
      .send({ user_id: userId })
      .expect(201);
    const newCookie = String(second.headers['set-cookie']).split(';')[0];

    expect(newCookie).not.toBe(first.cookie);
    await request(app.getHttpServer()).get('/session').set('Cookie', first.cookie).expect(401);
    await request(app.getHttpServer()).get('/session').set('Cookie', newCookie).expect(200);
    expect(await sessionKeys()).toHaveLength(1);
  });

  it('an unknown user → 404, and no session is created', async () => {
    await request(app.getHttpServer()).post('/sessions').send({ user_id: 999_999 }).expect(404);

    expect(await sessionKeys()).toEqual([]);
  });
});
