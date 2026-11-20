// POST /auth/login through the real app: the token pair, the access token's header,
// claims and signature, the stored refresh-token hash, and one answer for every bad
// credential.
import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, randomUUID, verify } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SignJWT } from 'jose';
import request from 'supertest';
import { RefreshTokenEntity, UserEntity } from '../../src/entities/index.js';
import { hashPassword } from '../../src/auth/password.js';
import { createTestApp } from '../integration/testkit/app.js';
import { aUser } from '../integration/testkit/builders.js';
import { startTestDatabase, type TestDatabase } from '../integration/testkit/postgres.js';
import { startTestQueue, type TestRedis } from '../integration/testkit/redis.js';

const PASSWORD = 'correct horse battery staple';

describe('Auth API (e2e)', () => {
  let db: TestDatabase;
  let queue: TestRedis;
  let app: NestExpressApplication;
  let passwordHash: string;
  let user: UserEntity;

  const login = (email: string, password: string) =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password });

  const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;

  beforeAll(async () => {
    // A real Redis for the token denylist: the guard fails closed, so with none
    // every protected route would answer 503.
    [db, queue] = await Promise.all([startTestDatabase(), startTestQueue()]);
    app = await createTestApp(db, { REDIS_QUEUE_URL: queue.url });
    passwordHash = await hashPassword(PASSWORD);
  });

  beforeEach(async () => {
    await db.reset();
    user = await aUser().withRole('seller').withPasswordHash(passwordHash).insertVia(db.app.getRepository(UserEntity));
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.stop(), queue?.stop()]);
  });

  it('returns an ES256 access token (alg + kid in the header) and an opaque refresh token', async () => {
    const response = await login(user.email, PASSWORD).expect(200);
    const { accessToken, refreshToken, expiresIn } = response.body as Record<string, string | number>;

    const [header, payload, signature] = String(accessToken).split('.');
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'test-2026-11', typ: 'JWT' });
    const claims = decode(payload);
    expect(claims).toMatchObject({ sub: String(user.id), role: 'seller', iss: 'm_api', aud: 'm_api' });
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(600);
    expect(expiresIn).toBe(600);
    // Seconds, not milliseconds: within a minute of now.
    expect(Math.abs(Number(claims.iat) - Date.now() / 1000)).toBeLessThan(60);

    const publicKey = createPublicKey(Buffer.from(process.env.JWT_PUBLIC_KEY!, 'base64').toString());
    expect(
      verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
    ).toBe(true);

    expect(refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('stores only the HMAC of the refresh token, a new family per login', async () => {
    const first = (await login(user.email, PASSWORD).expect(200)).body as { refreshToken: string };
    await login(user.email, PASSWORD).expect(200);

    const rows = await db.app.getRepository(RefreshTokenEntity).find({ order: { id: 'ASC' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].familyId).not.toBe(rows[1].familyId);
    expect(rows[0].tokenHash).toBe(
      createHmac('sha256', process.env.REFRESH_TOKEN_PEPPER!).update(first.refreshToken).digest('hex'),
    );
    expect(JSON.stringify(rows)).not.toContain(first.refreshToken);
    expect(rows[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(13 * 24 * 3600 * 1000);
  });

  it('a wrong password and an unknown email get the same 401', async () => {
    const wrong = await login(user.email, 'wrong password').expect(401);
    const unknown = await login('nobody@example.com', PASSWORD).expect(401);

    expect(wrong.body).toEqual({
      type: 'https://example.com/problems/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Invalid email or password.',
      instance: '/auth/login',
    });
    expect(unknown.body).toEqual(wrong.body);
    expect(await db.app.getRepository(RefreshTokenEntity).count()).toBe(0);
  });

  it('caps concurrent password checks: the rest get 503 with Retry-After at once', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => login(user.email, 'wrong password')));
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);

    expect(statuses).toEqual([401, 401, 503, 503, 503, 503]);
    const busy = responses.find((response) => response.status === 503)!;
    expect(busy.headers['retry-after']).toBe('1');
    expect(busy.body).toMatchObject({ type: 'https://example.com/problems/unavailable', status: 503 });

    await login(user.email, PASSWORD).expect(200);
  });

  it('a user without a password can not log in', async () => {
    const legacy = await aUser().insertVia(db.app.getRepository(UserEntity));

    await login(legacy.email, '').expect(400);
    await login(legacy.email, 'anything').expect(401);
  });

  describe('the access-token guard (every route unless @Public)', () => {
    const me = (token?: string) => {
      const req = request(app.getHttpServer()).get('/auth/me');
      return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
    };
    const testKey = () => createPrivateKey(Buffer.from(process.env.JWT_PRIVATE_KEY!, 'base64').toString());
    const now = () => Math.floor(Date.now() / 1000);
    const sign = (key: KeyObject, { kid = 'test-2026-11', iat = now(), exp = now() + 600 } = {}) =>
      new SignJWT({ role: 'customer' })
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
        .setSubject(String(user.id))
        .setJti(randomUUID())
        .setIssuer('m_api')
        .setAudience('m_api')
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(key);
    const rejected = async (token: string) => {
      const response = await me(token).expect(401);
      expect(response.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    };

    it('no token → 401 with WWW-Authenticate: Bearer (no error code)', async () => {
      const response = await me().expect(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      await request(app.getHttpServer()).get('/orders/1').expect(401);
    });

    it('a token from /auth/login → 200, req.user holds id, role, jti and exp', async () => {
      const { accessToken } = (await login(user.email, PASSWORD).expect(200)).body as { accessToken: string };
      const claims = decode(accessToken.split('.')[1]);

      const response = await me(accessToken).expect(200);

      expect(response.body).toEqual({ id: String(user.id), role: 'seller', jti: claims.jti, exp: claims.exp, sid: claims.sid });
    });

    it('a tampered token (role → admin, the old signature) → 401 invalid_token', async () => {
      const { accessToken } = (await login(user.email, PASSWORD).expect(200)).body as { accessToken: string };
      const [header, payload, signature] = accessToken.split('.');
      const forged = Buffer.from(JSON.stringify({ ...decode(payload), role: 'admin' })).toString('base64url');

      await rejected(`${header}.${forged}.${signature}`);
    });

    it('an expired token → 401 invalid_token (beyond the 5 s clock tolerance)', async () => {
      await rejected(await sign(testKey(), { iat: now() - 660, exp: now() - 60 }));
    });

    it('a token signed with another key → 401, with this kid or an unknown one', async () => {
      const { privateKey: otherKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

      await rejected(await sign(otherKey));
      await rejected(await sign(otherKey, { kid: 'prod-2026-11' }));
    });

    it('"alg": "none" with an empty signature → 401', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'test-2026-11' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: String(user.id), role: 'admin', jti: randomUUID(), iss: 'm_api', aud: 'm_api', iat: now(), exp: now() + 600 })).toString('base64url');

      await rejected(`${header}.${payload}.`);
    });

    it('accepts the scheme name in any case (RFC 9110)', async () => {
      const { accessToken } = (await login(user.email, PASSWORD).expect(200)).body as { accessToken: string };

      await request(app.getHttpServer()).get('/auth/me').set('Authorization', `bearer ${accessToken}`).expect(200);
    });

    it('the public routes answer without a token', async () => {
      await request(app.getHttpServer()).get('/products').expect(200);
      await request(app.getHttpServer()).get('/health').expect(200);
      await login(user.email, PASSWORD).expect(200);
    });
  });

  describe('POST /auth/refresh: rotation and reuse detection', () => {
    const refresh = (refreshToken: string) => request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken });
    const loginTokens = async () => (await login(user.email, PASSWORD).expect(200)).body as { refreshToken: string };
    const hashOf = (token: string) => createHmac('sha256', process.env.REFRESH_TOKEN_PEPPER!).update(token).digest('hex');
    const rowOf = (token: string) => db.app.getRepository(RefreshTokenEntity).findOneByOrFail({ tokenHash: hashOf(token) });
    const family = (familyId: string) => db.app.getRepository(RefreshTokenEntity).findBy({ familyId });

    it('rotates: a new pair, the old token marked used, the new one in the same family', async () => {
      const { refreshToken: r1 } = await loginTokens();

      const response = await refresh(r1).expect(200);
      const r2 = (response.body as { refreshToken: string }).refreshToken;

      expect(response.headers['cache-control']).toBe('no-store');
      expect(r2).not.toBe(r1);
      const [old, next] = [await rowOf(r1), await rowOf(r2)];
      expect(old.usedAt).not.toBeNull();
      expect(next.familyId).toBe(old.familyId);
      expect(next.usedAt).toBeNull();
      // A fixed maximum session: the successor keeps the login's deadline.
      expect(next.expiresAt.getTime()).toBe(old.expiresAt.getTime());
    });

    it('a reused token revokes the whole family (committed), so the honest client is out too', async () => {
      const { refreshToken: r1 } = await loginTokens();
      const { refreshToken: other } = await loginTokens();
      const r2 = ((await refresh(r1).expect(200)).body as { refreshToken: string }).refreshToken;

      await refresh(r1).expect(401);

      const rows = await family((await rowOf(r1)).familyId);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
      await refresh(r2).expect(401);
      // Another login's family is untouched.
      await refresh(other).expect(200);
    });

    it('an expired, unknown or empty token → 401', async () => {
      const { refreshToken } = await loginTokens();
      await db.app.getRepository(RefreshTokenEntity).update({ tokenHash: hashOf(refreshToken) }, { expiresAt: new Date(Date.now() - 1000) });

      await refresh(refreshToken).expect(401);
      await refresh('x'.repeat(43)).expect(401);
      await refresh('').expect(400);
    });

    it('two parallel refreshes of one token: one 200, one 401, and the family is revoked', async () => {
      const { refreshToken } = await loginTokens();

      const statuses = (await Promise.all([refresh(refreshToken), refresh(refreshToken)])).map((r) => r.status);

      expect(statuses.sort((a, b) => a - b)).toEqual([200, 401]);
      const rows = await family((await rowOf(refreshToken)).familyId);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    });

    it('the new access token carries the role as it is now in users', async () => {
      const { refreshToken } = await loginTokens();
      await db.app.getRepository(UserEntity).update({ id: user.id }, { role: 'customer' });

      const { accessToken } = (await refresh(refreshToken).expect(200)).body as { accessToken: string };

      expect(decode(accessToken.split('.')[1]).role).toBe('customer');
    });
  });

  describe('POST /auth/logout: the refresh family revoked, the access token denylisted', () => {
    const tokens = async () => (await login(user.email, PASSWORD).expect(200)).body as { accessToken: string; refreshToken: string };
    const me = (token: string) => request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${token}`);
    const logout = (token?: string) => {
      const req = request(app.getHttpServer()).post('/auth/logout');
      return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
    };
    const refresh = (refreshToken: string) => request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken });

    it('after logout, the access token and the refresh token both get 401', async () => {
      const { accessToken, refreshToken } = await tokens();
      await me(accessToken).expect(200);

      await logout(accessToken).expect(204);

      const after = await me(accessToken).expect(401);
      expect(after.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
      await refresh(refreshToken).expect(401);
    });

    it('denylist entries live exactly as long as the token would have', async () => {
      const { accessToken } = await tokens();
      const { jti, exp, sid } = decode(accessToken.split('.')[1]) as { jti: string; exp: number; sid: string };

      await logout(accessToken).expect(204);

      const remaining = exp - Math.floor(Date.now() / 1000);
      const ttl = Number(await queue.cli('TTL', `deny:jti:${jti}`));
      expect(ttl).toBeGreaterThan(0);
      // + the 5 s clock tolerance: jose still accepts the token until exp + 5 s.
      expect(ttl).toBeGreaterThan(remaining);
      expect(ttl).toBeLessThanOrEqual(remaining + 5 + 1);
      expect(Number(await queue.cli('TTL', `deny:sid:${sid}`))).toBeLessThanOrEqual(600 + 5);
    });

    it('a logged-out token stays rejected through the 5 s clock tolerance after its exp', async () => {
      // jose accepts a token until exp + 5 s, so its denylist entries must outlive exp
      // by as much, or the token works again in that window. The sid entry is removed
      // to test the jti entry alone (it would cover this token: it lives 600 s from now).
      const key = createPrivateKey(Buffer.from(process.env.JWT_PRIVATE_KEY!, 'base64').toString());
      const now = Math.floor(Date.now() / 1000);
      const sid = randomUUID();
      const accessToken = await new SignJWT({ role: 'seller', sid })
        .setProtectedHeader({ alg: 'ES256', kid: 'test-2026-11', typ: 'JWT' })
        .setSubject(String(user.id))
        .setJti(randomUUID())
        .setIssuer('m_api')
        .setAudience('m_api')
        .setIssuedAt(now)
        .setExpirationTime(now + 2)
        .sign(key);
      await logout(accessToken).expect(204);
      // The sid entry outlives the longest access token of the login by the tolerance too.
      expect(Number(await queue.cli('TTL', `deny:sid:${sid}`))).toBeGreaterThan(600);
      await queue.cli('DEL', `deny:sid:${sid}`);

      await new Promise((resolve) => setTimeout(resolve, 3_000));

      await me(accessToken).expect(401);
    });

    it('ends one login only: another session of the same user keeps working', async () => {
      const first = await tokens();
      const second = await tokens();

      await logout(first.accessToken).expect(204);

      await me(second.accessToken).expect(200);
      await refresh(second.refreshToken).expect(200);
    });

    it('needs an access token', async () => {
      await logout().expect(401);
    });

    it('a detected reuse also cuts off the access token the attacker got from refreshing', async () => {
      const { refreshToken } = await tokens();
      const attacker = (await refresh(refreshToken).expect(200)).body as { accessToken: string };
      await me(attacker.accessToken).expect(200);

      await refresh(refreshToken).expect(401);

      await me(attacker.accessToken).expect(401);
    });

    it('fails closed: when the denylist cannot be checked, protected routes answer 503 with Retry-After', async () => {
      const { accessToken } = await tokens();
      await queue.cli('CLIENT', 'PAUSE', '1500', 'ALL');

      const response = await me(accessToken).expect(503);

      expect(response.headers['retry-after']).toBe('1');
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      await me(accessToken).expect(200);
    });
  });
});
