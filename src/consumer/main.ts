// The invoicing consumer: a separate process (npm run consumer), with its own DB
// pool and its own AMQP connection. It reads order.placed from shop.invoicing and
// writes one invoice per event, then adds the invoice-email job (BullMQ), acking
// only after both.
//
// stdout: one JSON line per delivery and per outcome (report.ts), for the demos.
// stderr: human-readable logs.
import 'reflect-metadata';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
  connect,
} from 'amqplib';
import type { Queue } from 'bullmq';
import type { DataSource } from 'typeorm';
import { type Env, validate } from '../config/env.schema.js';
import { createAppDataSource } from '../db/app-data-source.js';
import {
  type OrderPlacedEvent,
  orderPlacedReader,
} from '../messaging/order-placed.js';
import { INVOICING_QUEUE, declareTopology } from '../messaging/topology.js';
import { addInvoiceEmail, createJobsQueue } from '../jobs/jobs.js';
import { closeRedis, createQueueClient } from '../redis/redis-clients.js';
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

// An error's message, or for a refused connection to localhost (::1 and 127.0.0.1,
// an AggregateError with an empty message) its first inner error's.
const errorText = (error: unknown): string => {
  const { message, errors } = error as { message?: string; errors?: Error[] };
  return message || errors?.[0]?.message || String(error);
};

// Waits that double each time, from 1 s up to 30 s: attempt 0 → 1 s, 1 → 2 s, …
const backoff = (attempt: number) => Math.min(1_000 * 2 ** attempt, 30_000);

// The pause before a message whose job add failed goes back (see handle()).
const JOB_ADD_RETRY_MS = 5_000;

// Aborted on SIGTERM/SIGINT: cuts every wait short (a retry pause, a reconnect
// pause) and stops reconnecting, so a stop is never held up by a backoff.
const stopping = new AbortController();

// Resolves after `ms`, or false at once if the process is stopping.
const pause = (ms: number): Promise<boolean> =>
  sleep(ms, true, { signal: stopping.signal }).catch(() => false);

type Parsed =
  | { ok: true; event: OrderPlacedEvent }
  | { ok: false; reason: string };

// The tolerant reader (order.placed v2): unknown fields are dropped; a body that
// isn't JSON, an unknown type or version (v1 included), or a missing or invalid
// field is poison.
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
  return { ok: false, reason: `not order.placed v2: ${issues}` };
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
  jobs: Queue,
  message: ConsumeMessage,
): Promise<void> {
  const messageId =
    typeof message.properties.messageId === 'string'
      ? message.properties.messageId
      : null;
  // How many times the broker has returned this message to the queue before.
  const deliveryCount = Number(
    message.properties.headers?.['x-delivery-count'] ?? 0,
  );
  report({
    event: 'delivery',
    messageId,
    redelivered: message.fields.redelivered,
    deliveryCount,
  });

  // reject, not nack: on quorum queues (RabbitMQ 4.x) only reject with requeue
  // counts toward the delivery-limit, so a transient failure can't loop forever.
  // The one exception is a failed job add after the commit (nack, below).
  const reject = (requeue: boolean, reason: string) => {
    channel.reject(message, requeue);
    report({ event: 'rejected', messageId, requeue, reason });
    log(`rejected messageId=${messageId} requeue=${requeue}: ${reason}`);
  };

  const parsed = parse(message.content);
  if (!parsed.ok) return reject(false, parsed.reason);

  let result: Awaited<ReturnType<typeof insertInvoice>>;
  try {
    // One transaction: the processed_messages row and the invoice commit together.
    result = await insertInvoice(dataSource, parsed.event);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const reason = `${typeof code === 'string' ? code : 'no code'}: ${errorText(error)}`;
    if (isPermanent(error)) return reject(false, reason);

    // Transient: wait before the requeue, longer on each delivery (1, 2, 4, 8, 16,
    // 30 s), so the 6 deliveries delivery-limit 5 allows span about a minute, not
    // milliseconds: enough for a DB restart. The message stays unacked meanwhile,
    // holding one prefetch slot, far below the 30-minute consumer_timeout.
    const delay = backoff(deliveryCount);
    log(`messageId=${messageId}: transient failure, requeue in ${delay} ms: ${reason}`);
    // Stopping: leave it unacked; closing the channel returns it to the queue.
    if (!(await pause(delay))) return;
    return reject(true, reason);
  }

  // Then the email job, before the ack, for every outcome, a skipped duplicate too:
  // if an earlier delivery committed and died before adding it, this one adds it.
  // The job id makes a second add a no-op.
  //
  // If Redis is down, the message goes back with nack, not reject: on quorum queues
  // only reject counts toward the delivery limit, and this message is fine (its
  // invoice is committed); a long Redis outage mustn't dead-letter valid events.
  // nack doesn't raise x-delivery-count, so the pause is fixed, not the growing
  // backoff. The cost: a job add that could never succeed would loop, one try per
  // message every 5 s, visible in the log, until fixed.
  try {
    await addInvoiceEmail(jobs, parsed.event.data.orderId);
  } catch (error) {
    const reason = `invoice-email job not added: ${errorText(error)}`;
    log(`messageId=${messageId}: ${reason}; requeue (nack) in ${JOB_ADD_RETRY_MS} ms`);
    if (!(await pause(JOB_ADD_RETRY_MS))) return;
    channel.nack(message, false, true);
    report({ event: 'requeued', messageId: parsed.event.eventId, reason });
    return;
  }

  if (CRASH_AFTER_EFFECT) {
    log('CONSUMER_CRASH_AFTER_EFFECT=1: SIGKILL after the commit, before the ack');
    process.kill(process.pid, 'SIGKILL');
  }

  // After the commit: an ack before it, then a crash, would lose the effect for good.
  channel.ack(message);
  if (result.outcome === 'applied') {
    report({ event: 'applied', messageId: parsed.event.eventId });
  } else {
    report({ event: 'skipped', messageId: parsed.event.eventId, reason: result.reason });
    log(`skipped messageId=${parsed.event.eventId}: ${result.reason}`);
  }
}

interface Session {
  connection: ChannelModel;
  channel: Channel;
  consumerTag: string;
}

// One connection + channel + consumer. `onLost` runs once if the connection closes
// later for any reason (the broker restarts, a channel error, the consumer is
// cancelled): the caller reconnects.
async function openSession(
  env: Env,
  dataSource: DataSource,
  jobs: Queue,
  inFlight: Set<Promise<void>>,
  onLost: () => void,
): Promise<Session> {
  const connection = await connect(env.RABBITMQ_URL, { timeout: 5_000 });
  // An 'error' event with no listener is an uncaught exception.
  connection.on('error', (error: Error) =>
    log(`connection error: ${error.message}`),
  );
  try {
    const channel = await connection.createChannel();
    channel.on('error', (error: Error) =>
      log(`channel error: ${error.message}`),
    );
    // A closed channel (a 404/406) ends the session: close its connection too, so
    // there's one path to reconnect, through the connection's 'close'.
    channel.on('close', () => void connection.close().catch(() => {}));

    // The consumer side may declare (idempotent); policies need the bootstrap.
    await declareTopology(channel);
    // What the channel's basic.qos was set to, reported in the ready line. Without
    // the call it stays 0: no limit, the broker pushes the whole queue at once.
    let prefetch = 0;
    await channel.prefetch(PREFETCH);
    prefetch = PREFETCH;

    const { consumerTag } = await channel.consume(
      INVOICING_QUEUE,
      (message) => {
        if (!message) {
          // Cancelled by the broker (e.g. the queue was deleted): start over,
          // which declares the queue again.
          log('consumer cancelled by the broker');
          void connection.close().catch(() => {});
          return;
        }
        const work = handle(channel, dataSource, jobs, message)
          .catch((error: unknown) =>
            log(`handler failed: ${(error as Error).message}`),
          )
          .finally(() => inFlight.delete(work));
        inFlight.add(work);
      },
      { noAck: false },
    );

    // Only now: a failure during setup throws to the caller, which retries.
    connection.once('close', onLost);
    report({ event: 'ready', prefetch });
    log(`consuming ${INVOICING_QUEUE}, prefetch ${prefetch}`);
    return { connection, channel, consumerTag };
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
}

async function main(): Promise<void> {
  const env = validate(process.env);
  const dataSource = await createAppDataSource(env.DB_URL, {
    poolSize: PREFETCH,
  }).initialize();
  const redis = createQueueClient(env.REDIS_QUEUE_URL);
  const jobs = createJobsQueue(redis);

  const inFlight = new Set<Promise<void>>();
  let session: Session | undefined;

  // Connects, retrying with backoff (1 s … 30 s) until it works or the process is
  // stopping. Used at startup and after every lost connection, so the consumer
  // comes back by itself when the broker does, with no supervisor.
  const connectWithRetry = async (): Promise<void> => {
    for (let attempt = 0; !stopping.signal.aborted; attempt++) {
      try {
        session = await openSession(env, dataSource, jobs, inFlight, onLost);
        return;
      } catch (error) {
        const delay = backoff(attempt);
        log(`can't reach RabbitMQ (${errorText(error)}); retrying in ${delay} ms`);
        if (!(await pause(delay))) return;
      }
    }
  };

  // The connection is gone: its unacked deliveries return to the queue, and the
  // idempotent INSERT makes their redelivery harmless. Handlers still running on the
  // old channel fail to ack and log it; the redelivery takes over.
  function onLost(): void {
    session = undefined;
    if (stopping.signal.aborted) return;
    log('lost the connection to RabbitMQ; reconnecting');
    void connectWithRetry();
  }

  // Graceful stop: no new deliveries, let the ones in flight finish (a retry pause
  // ends at once), then close. Whatever is still unacked returns to the queue.
  const shutdown = async (signal: string) => {
    if (stopping.signal.aborted) return;
    stopping.abort();
    log(`${signal}: stopping`);
    const current = session;
    try {
      // Already gone if the connection dropped meanwhile: nothing to cancel.
      await current?.channel.cancel(current.consumerTag).catch(() => {});
      await Promise.allSettled(inFlight);
      if (current) await current.connection.close().catch(() => {});
      await jobs.close();
      await closeRedis(redis);
      await dataSource.destroy();
      process.exit(0);
    } catch (error) {
      log(`shutdown failed: ${(error as Error).message}`);
      process.exit(1);
    }
  };
  // Before connecting: a stop must work while it's still retrying.
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await connectWithRetry();
}

try {
  await main();
} catch (error) {
  log(`startup failed: ${errorText(error)}`);
  process.exit(1);
}
