// The WebSocket gateway authenticates its own handshake (the HTTP guard doesn't run
// for socket connections): the same access token, verified the same way.
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { io } from 'socket.io-client';
import { createTestApp } from '../integration/testkit/app.js';
import { startTestDatabase, type TestDatabase } from '../integration/testkit/postgres.js';
import { accessTokenFor } from '../integration/testkit/tokens.js';
import { startTestQueue, type TestRedis } from '../integration/testkit/redis.js';

describe('Realtime gateway handshake (e2e)', () => {
  let db: TestDatabase;
  let queue: TestRedis;
  let app: NestExpressApplication;
  let url: string;

  // 'connected', or the connect_error's message.
  const handshake = (auth: Record<string, unknown>) =>
    new Promise<string>((resolve) => {
      const socket = io(`${url}/orders`, { auth, reconnection: false, transports: ['websocket'] });
      socket.on('connect', () => {
        socket.disconnect();
        resolve('connected');
      });
      socket.on('connect_error', (error) => {
        socket.disconnect();
        resolve(error.message);
      });
    });

  beforeAll(async () => {
    // A real Redis for the token denylist: the guard fails closed, so with none
    // every protected route would answer 503.
    [db, queue] = await Promise.all([startTestDatabase(), startTestQueue()]);
    app = await createTestApp(db, { REDIS_QUEUE_URL: queue.url });
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.stop(), queue?.stop()]);
  });

  it('refuses a handshake without a token, or with the old userId claim', async () => {
    expect(await handshake({})).toBe('unauthorized');
    expect(await handshake({ userId: 1 })).toBe('unauthorized');
  });

  it('refuses a tampered token', async () => {
    const [header, payload, signature] = (await accessTokenFor({ id: '2' })).split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: '1' })).toString('base64url');

    expect(await handshake({ token: `${header}.${forged}.${signature}` })).toBe('unauthorized');
  });

  it('accepts a valid access token', async () => {
    expect(await handshake({ token: await accessTokenFor({ id: '1' }) })).toBe('connected');
  });
});
