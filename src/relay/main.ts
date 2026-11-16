// The outbox relay: a separate process (npm run relay), so it can be killed (kill
// -9 in demo:crash-relay) without touching the API. It publishes committed outbox
// rows to RabbitMQ; the logic is in relay.ts.
import 'reflect-metadata';
import { validate } from '../config/env.schema.js';
import { createAppDataSource } from '../db/app-data-source.js';
import { OrderPlacedPublisher } from '../messaging/order-placed.publisher.js';
import { DEFAULTS, runRelay } from './relay.js';

// The pid tells two relays' logs apart.
const log = (message: string) =>
  console.error(`[relay ${process.pid}] ${message}`);

// DEMO ONLY (npm run demo:crash-relay): SIGKILL this process after a batch's confirms
// and before its rows are marked published: a real crash at the worst moment.
// Honoured only with both variables set to exactly 1 (the demo sets both) and never
// with NODE_ENV=production, so one stray variable can't switch it on.
const CRASH_REQUESTED = process.env.RELAY_CRASH_AFTER_CONFIRM === '1';
const CRASH_AFTER_CONFIRM =
  CRASH_REQUESTED &&
  process.env.DEMO_RUN === '1' &&
  process.env.NODE_ENV !== 'production';

const errorText = (error: unknown): string => {
  const { message, errors } = error as { message?: string; errors?: Error[] };
  return message || errors?.[0]?.message || String(error);
};

async function main(): Promise<void> {
  const env = validate(process.env);
  // 2 connections: the batch transaction, and the backlog query between batches.
  const dataSource = await createAppDataSource(env.DB_URL, {
    poolSize: 2,
  }).initialize();
  const publisher = new OrderPlacedPublisher(env.RABBITMQ_URL);

  // Graceful stop: the batch in progress finishes (its rows marked or not, then
  // committed); only the sleeps are cut short. Then close the broker and the DB.
  const stopping = new AbortController();
  const stop = (signal: string) => {
    if (stopping.signal.aborted) return;
    log(`${signal}: stopping after the current batch`);
    stopping.abort();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  if (CRASH_REQUESTED && !CRASH_AFTER_CONFIRM) {
    log('RELAY_CRASH_AFTER_CONFIRM ignored: needs DEMO_RUN=1 and NODE_ENV not production');
  }
  log(
    `polling outbox: batch ${DEFAULTS.batchSize}, every ${DEFAULTS.pollMs} ms, max attempts ${DEFAULTS.maxAttempts}`,
  );
  await runRelay(dataSource, publisher, {
    signal: stopping.signal,
    log,
    options: {
      ...DEFAULTS,
      afterConfirms: CRASH_AFTER_CONFIRM
        ? () => {
            log('RELAY_CRASH_AFTER_CONFIRM=1: SIGKILL after the confirms, before the UPDATE');
            process.kill(process.pid, 'SIGKILL');
          }
        : undefined,
    },
  });

  await publisher.close();
  await dataSource.destroy();
  log('stopped');
}

try {
  await main();
  process.exit(0);
} catch (error) {
  log(`failed: ${errorText(error)}`);
  process.exit(1);
}
