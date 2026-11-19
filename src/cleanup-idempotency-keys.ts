// npm run idempotency:cleanup: deletes Idempotency-Keys older than 24 h. A retry
// after that creates a new order. Meant to run periodically (cron, like
// backup.cron); safe to run any time.
import { runtimeDataSource as dataSource } from './runtime-data-source.js';

const RETENTION = '24 hours';

await dataSource.initialize();
try {
  const [, deleted] = (await dataSource.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - $1::interval`,
    [RETENTION],
  )) as [unknown[], number];
  console.log(`idempotency keys older than ${RETENTION} deleted: ${deleted}`);
} finally {
  await dataSource.destroy();
}
