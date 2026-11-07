// Smoke check for the broker path: compose → secret → client (HW#19).
//
//   npm run rabbitmq:smoke     (through scripts/with-secrets.sh, which provides RABBITMQ_URL)
//
// Connects, opens a confirm channel, prints the server's product and version,
// closes, exits 0. Any failure, a refused login included, exits 1 with the reason.

import { connect } from 'amqplib';

const url = process.env.RABBITMQ_URL;
if (!url) {
  console.error(
    'RABBITMQ_URL is not set: run through scripts/with-secrets.sh, or export it with SKIP_VAULT=1',
  );
  process.exit(1);
}

// The URL without its password, for messages.
const shown = url.replace(/\/\/([^:@/]*):[^@/]*@/, '//$1:***@');

try {
  // timeout: a host that drops packets fails within 5 s instead of hanging.
  const connection = await connect(url, { timeout: 5_000 });
  const channel = await connection.createConfirmChannel();
  const { product, version } = connection.connection.serverProperties;
  console.log(
    `connected to ${shown}: ${product} ${version}, confirm channel open`,
  );
  await channel.close();
  await connection.close();
} catch (error) {
  console.error(`RabbitMQ smoke check failed for ${shown}: ${error.message}`);
  process.exit(1);
}
