// The HW#22 demos' fixture and counts. Every run gets a fresh user and product,
// and every count is scoped to that user, so the dev data, the seed, earlier runs
// and old outbox rows published meanwhile never change the numbers.
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { ConsumerLine } from '../consumer/report.js';
import { hashPassword } from '../auth/password.js';
import { createAppDataSource } from '../db/app-data-source.js';
import { linesOf, requireEnv } from './lib.js';

export interface RunFixture {
  userId: string;
  productId: string;
  // The user can log in (POST /auth/login) with these: the order routes need a token.
  email: string;
  password: string;
}

// The app's own connection (app_user through PgBouncer), like the API.
export const openAppDb = (): Promise<DataSource> =>
  createAppDataSource(requireEnv('DB_URL')).initialize();

// A user who can afford anything (and log in), and a product with stock to spare.
export async function createFixture(db: DataSource): Promise<RunFixture> {
  const tag = randomUUID().slice(0, 8);
  const email = `demo-${tag}@example.com`;
  const password = `demo-${tag}-password`;
  const [user] = (await db.query(
    `INSERT INTO users (email, balance_cents, password_hash) VALUES ($1, 100000000, $2) RETURNING id`,
    [email, await hashPassword(password)],
  )) as { id: string }[];
  const [product] = (await db.query(
    `INSERT INTO products (name, description, price_cents, stock)
     VALUES ($1, 'For the HW#22 demos', 1000, 10) RETURNING id`,
    [`Demo product ${tag}`],
  )) as { id: string }[];
  return { userId: String(user.id), productId: String(product.id), email, password };
}

export interface RunCounts {
  orders: number;
  // Outbox rows for this run's orders (by the payload's userId: a row whose order
  // rolled back would still be found, which demo:crash-write needs).
  outbox: number;
  published: number;
  // Invoices of this run's orders.
  effect: number;
  // This run's events in processed_messages, for the invoicing consumer.
  processed: number;
  eventIds: string[];
}

export async function countRun(db: DataSource, userId: string): Promise<RunCounts> {
  const [row] = (await db.query(
    `SELECT
       (SELECT count(*) FROM orders WHERE user_id = $1)::int AS orders,
       (SELECT count(*) FROM outbox WHERE payload->'data'->>'userId' = $1::text)::int AS outbox,
       (SELECT count(*) FROM outbox WHERE payload->'data'->>'userId' = $1::text AND published_at IS NOT NULL)::int AS published,
       (SELECT count(*) FROM invoices i JOIN orders o ON o.id = i.order_id WHERE o.user_id = $1)::int AS effect,
       (SELECT count(*) FROM processed_messages p JOIN outbox ob ON ob.id = p.message_id
         WHERE ob.payload->'data'->>'userId' = $1::text AND p.consumer = 'invoicing')::int AS processed,
       (SELECT coalesce(array_agg(id::text), '{}') FROM outbox WHERE payload->'data'->>'userId' = $1::text) AS "eventIds"`,
    [userId],
  )) as RunCounts[];
  return row;
}

// The consumer's report lines for this run's events only.
export const runLines = (lines: ConsumerLine[], eventIds: string[]) => {
  const ours = (line: { messageId: string | null }) =>
    line.messageId !== null && eventIds.includes(line.messageId);
  return {
    deliveries: linesOf(lines, 'delivery').filter(ours).length,
    applied: linesOf(lines, 'applied').filter(ours).length,
    skipped: linesOf(lines, 'skipped').filter(ours).length,
  };
};
