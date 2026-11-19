// npm run processed-messages:cleanup: deletes consumer inbox rows older than 30 days.
// The inbox only has to outlive redeliveries (relay retries take minutes, a DLQ'd
// message is replayed by hand within days); a duplicate arriving even later still
// meets the natural key (invoices.order_id) and is skipped. Meant to run
// periodically (cron, like backup.cron); safe to run any time.
import { runtimeDataSource as dataSource } from './runtime-data-source.js';

const RETENTION = '30 days';

await dataSource.initialize();
try {
  const [, deleted] = (await dataSource.query(
    `DELETE FROM processed_messages WHERE processed_at < now() - $1::interval`,
    [RETENTION],
  )) as [unknown[], number];
  console.log(`processed messages older than ${RETENTION} deleted: ${deleted}`);
} finally {
  await dataSource.destroy();
}
