import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connect } from 'amqplib';
import {
  ALTERNATE_EXCHANGE,
  DEAD_LETTER_EXCHANGE,
  DELIVERY_LIMIT,
  EVENTS_EXCHANGE,
  INVOICING_QUEUE,
  declareTopology,
} from './topology.js';

const run = promisify(execFile);

// From src/messaging/ or dist/messaging/ alike: two levels up is the repo root.
const POLICIES_SCRIPT = fileURLToPath(
  new URL('../../scripts/rabbitmq-policies.sh', import.meta.url),
);

// The whole broker setup, idempotent: policies, then exchanges, queues and bindings.
// Run by `npm run rabbitmq:bootstrap` and by each demo's reset step, never by the
// producer. The order doesn't matter to RabbitMQ (a policy also applies to objects
// declared later), but this way a missing docker or a bad policy fails first.
export async function bootstrapRabbitMQ(url: string): Promise<void> {
  await run('bash', [
    POLICIES_SCRIPT,
    INVOICING_QUEUE,
    DEAD_LETTER_EXCHANGE,
    String(DELIVERY_LIMIT),
    EVENTS_EXCHANGE,
    ALTERNATE_EXCHANGE,
  ]);

  const connection = await connect(url, { timeout: 5_000 });
  try {
    const channel = await connection.createChannel();
    await declareTopology(channel);
    await channel.close();
  } finally {
    await connection.close();
  }
}
