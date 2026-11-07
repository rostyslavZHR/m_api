// The invoicing consumer: a separate process (npm run consumer), with its own DB
// pool and its own AMQP connection. It reads order.placed from shop.invoicing and
// writes one invoice per event, acking only after the invoice has committed.
//
// stdout: one JSON line per delivery and per outcome (report.ts), for the demos.
// stderr: human-readable logs.
import 'reflect-metadata';
import { type Channel, type ConsumeMessage, connect } from 'amqplib';
import type { DataSource } from 'typeorm';
import { validate } from '../config/env.schema.js';
import { createAppDataSource } from '../db/app-data-source.js';
import {
  type OrderPlacedEvent,
  orderPlacedReader,
} from '../messaging/order-placed.js';
import { INVOICING_QUEUE, declareTopology } from '../messaging/topology.js';
import { insertInvoice } from './invoices.js';
import { report } from './report.js';

// Up to 10 unacked deliveries at once. Each is one INSERT plus an ack, well under a
// second even when slow, so 10 in flight stays far below the 30-minute
// consumer_timeout; and 10 matches the DB pool below, so none waits for a connection.
const PREFETCH = 10;

// DEMO ONLY (npm run demo:duplicate): kill this process with SIGKILL after the
// invoice has committed and before the ack, i.e. a real crash at the worst moment.
// Off unless set to exactly 1. Never set it anywhere else.
const CRASH_AFTER_EFFECT = process.env.CONSUMER_CRASH_AFTER_EFFECT === '1';

const log = (message: string) => console.error(`[consumer] ${message}`);

type Parsed =
  | { ok: true; event: OrderPlacedEvent }
  | { ok: false; reason: string };

// The tolerant reader: unknown fields are dropped; a body that isn't JSON, an
// unknown type or version, or a missing or invalid field is poison.
function parse(content: Buffer): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(content.toString('utf8'));
  } catch {
    return { ok: false, reason: 'body is not JSON' };
  }
  const result = orderPlacedReader.safeParse(json);
  if (result.success) return { ok: true, event: result.data };
  const issues = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { ok: false, reason: `not order.placed v1: ${issues}` };
}

// Postgres error classes that fail the same way every time: 22 data exception,
// 23 integrity violation (23503: the order doesn't exist). Anything else (no
// connection, a timeout, 40001/40P01) may pass on the next try.
const isPermanent = (error: unknown): boolean => {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^2[23]/.test(code);
};

async function handle(
  channel: Channel,
  dataSource: DataSource,
  message: ConsumeMessage,
): Promise<void> {
  const messageId =
    typeof message.properties.messageId === 'string'
      ? message.properties.messageId
      : null;
  report({
    event: 'delivery',
    messageId,
    redelivered: message.fields.redelivered,
    deliveryCount: Number(message.properties.headers?.['x-delivery-count'] ?? 0),
  });

  // reject, never nack: on quorum queues (RabbitMQ 4.x) only reject with requeue
  // counts toward the delivery-limit, so a transient failure can't loop forever.
  const reject = (requeue: boolean, reason: string) => {
    channel.reject(message, requeue);
    report({ event: 'rejected', messageId, requeue, reason });
    log(`rejected messageId=${messageId} requeue=${requeue}: ${reason}`);
  };

  const parsed = parse(message.content);
  if (!parsed.ok) return reject(false, parsed.reason);

  let outcome: Awaited<ReturnType<typeof insertInvoice>>;
  try {
    outcome = await insertInvoice(dataSource, parsed.event);
  } catch (error) {
    const code = (error as { code?: unknown }).code ?? 'no code';
    return reject(
      !isPermanent(error),
      `${String(code)}: ${(error as Error).message}`,
    );
  }

  if (CRASH_AFTER_EFFECT) {
    log('CONSUMER_CRASH_AFTER_EFFECT=1: SIGKILL after the commit, before the ack');
    process.kill(process.pid, 'SIGKILL');
  }

  channel.ack(message);
  report({ event: outcome, messageId: parsed.event.eventId });
}

async function main(): Promise<void> {
  const env = validate(process.env);
  const dataSource = await createAppDataSource(env.DB_URL, {
    poolSize: PREFETCH,
  }).initialize();

  const connection = await connect(env.RABBITMQ_URL, { timeout: 5_000 });
  let stopping = false;
  // Without a supervisor to reconnect cleanly, losing the broker ends the process:
  // its unacked deliveries go back to the queue, and a restart picks them up.
  const lost = (what: string) => {
    if (stopping) return;
    log(`${what} closed unexpectedly; exiting`);
    process.exit(1);
  };
  connection.on('error', (error: Error) =>
    log(`connection error: ${error.message}`),
  );
  connection.on('close', () => lost('connection'));

  const channel = await connection.createChannel();
  channel.on('error', (error: Error) => log(`channel error: ${error.message}`));
  channel.on('close', () => lost('channel'));

  // The consumer side may declare (idempotent); policies need the bootstrap.
  await declareTopology(channel);
  // What the channel's basic.qos was set to, reported in the ready line. Without
  // the call it stays 0: no limit, the broker pushes the whole queue at once.
  let prefetch = 0;
  await channel.prefetch(PREFETCH);
  prefetch = PREFETCH;

  const inFlight = new Set<Promise<void>>();
  const { consumerTag } = await channel.consume(
    INVOICING_QUEUE,
    (message) => {
      if (!message) return lost('consumer (cancelled by the broker)');
      const work = handle(channel, dataSource, message)
        .catch((error: unknown) =>
          log(`handler failed: ${(error as Error).message}`),
        )
        .finally(() => inFlight.delete(work));
      inFlight.add(work);
    },
    { noAck: false },
  );

  report({ event: 'ready', prefetch });
  log(`consuming ${INVOICING_QUEUE}, prefetch ${prefetch}`);

  // Graceful stop: no new deliveries, let the ones in flight finish and ack, then
  // close. Whatever is still unacked returns to the queue when the channel closes.
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping`);
    try {
      await channel.cancel(consumerTag);
      await Promise.allSettled(inFlight);
      await channel.close();
      await connection.close();
      await dataSource.destroy();
      process.exit(0);
    } catch (error) {
      log(`shutdown failed: ${(error as Error).message}`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

try {
  await main();
} catch (error) {
  log(`startup failed: ${(error as Error).message}`);
  process.exit(1);
}
