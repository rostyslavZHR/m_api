// npm run rabbitmq:bootstrap (through scripts/with-secrets.sh, which provides
// RABBITMQ_URL): sets the policies and declares the topology. Safe to re-run.
import { bootstrapRabbitMQ } from './messaging/bootstrap.js';

const url = process.env.RABBITMQ_URL;
if (!url) {
  console.error(
    'RABBITMQ_URL is not set: run through scripts/with-secrets.sh, or export it with SKIP_VAULT=1',
  );
  process.exit(1);
}

try {
  await bootstrapRabbitMQ(url);
  console.log('RabbitMQ topology and policies in place');
} catch (error) {
  // execFile's error carries the script's stderr.
  const stderr = (error as { stderr?: string }).stderr?.trim();
  console.error(
    `RabbitMQ bootstrap failed: ${stderr || (error as Error).message}`,
  );
  process.exit(1);
}
