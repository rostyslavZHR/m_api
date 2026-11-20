// What the HW#24 demos (auth, reuse, rbac) share. Each run creates its own users,
// random emails and known passwords, and deletes everything it made at the end,
// including the denylist entries its logouts left in Redis: nothing depends on the
// seed or on an earlier run, and nothing is left for the next one.
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { hashPassword } from '../auth/password.js';
import type { UserRole } from '../entities/index.js';
import { closeRedis, createDenylistClient } from '../redis/redis-clients.js';
import { connected, requireEnv } from './lib.js';

type OnCleanup = (fn: () => Promise<void>) => void;

export interface DemoUser {
  id: string;
  email: string;
  password: string;
}

export interface Fixtures {
  user(role: UserRole): Promise<DemoUser>;
  // A product to delete at the end (one the demo created through the API).
  ownProduct(id: string): void;
  // A token whose denylist entries (if a logout or a reuse made any) go at the end.
  ownToken(token: string): void;
}

// The payload of a JWT, for its jti and sid. Never printed.
export const claimsOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Record<string, unknown>;

// `admin` is the schema owner's connection (from migrate()): it may delete products,
// which app_user can't.
export async function fixtures(admin: DataSource, onCleanup: OnCleanup): Promise<Fixtures> {
  const users: string[] = [];
  const products: string[] = [];
  const tokens: string[] = [];
  const redis: Redis = createDenylistClient(requireEnv('REDIS_QUEUE_URL'));
  onCleanup(() => closeRedis(redis));
  await connected(redis);

  // Registered after the Redis client, so it runs before the client closes. Orders
  // first (their items and events cascade; they hold the products and users), then
  // products, then users (refresh tokens cascade).
  onCleanup(async () => {
    await admin.transaction(async (manager) => {
      if (users.length) await manager.query('DELETE FROM orders WHERE user_id = ANY($1::bigint[])', [users]);
      if (products.length) await manager.query('DELETE FROM products WHERE id = ANY($1::bigint[])', [products]);
      if (users.length) await manager.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [users]);
    });
    const keys = tokens.flatMap((token) => {
      const { jti, sid } = claimsOf(token);
      return [`deny:jti:${String(jti)}`, `deny:sid:${String(sid)}`];
    });
    if (keys.length) await redis.del(...keys);
  });

  return {
    async user(role) {
      const tag = randomUUID().slice(0, 8);
      const email = `demo-auth-${tag}@example.com`;
      const password = `demo-${tag}-password`;
      const [row] = (await admin.query(
        `INSERT INTO users (email, role, balance_cents, password_hash) VALUES ($1, $2, 0, $3) RETURNING id`,
        [email, role, await hashPassword(password)],
      )) as { id: string }[];
      users.push(String(row.id));
      return { id: String(row.id), email, password };
    },
    ownProduct: (id) => void products.push(id),
    ownToken: (token) => void tokens.push(token),
  };
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

// One request to the API; the body is read whole (so the connection is free) and
// parsed when it's JSON.
export const http =
  (url: string) =>
  async (method: string, path: string, { token, body }: { token?: string; body?: unknown } = {}): Promise<Reply> => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // not JSON: only the status matters
    }
    return { status: response.status, body: parsed };
  };
