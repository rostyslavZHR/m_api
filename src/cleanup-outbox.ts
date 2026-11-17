// npm run outbox:cleanup: deletes outbox rows published more than 7 days ago. Rows
// still waiting (published_at IS NULL, parked ones included) are never touched.
// Consumers dedupe by the event id in processed_messages, not by the outbox row, so
// a later redelivery is still skipped. Meant to run periodically (cron, like
// backup.cron); safe to run any time.
import { runtimeDataSource as dataSource } from './runtime-data-source.js';

const RETENTION = '7 days';

await dataSource.initialize();
try {
  const [, deleted] = (await dataSource.query(
    `DELETE FROM outbox WHERE published_at < now() - $1::interval`,
    [RETENTION],
  )) as [unknown[], number];
  console.log(`outbox rows published more than ${RETENTION} ago deleted: ${deleted}`);
} finally {
  await dataSource.destroy();
}
