// npm run processed-messages:cleanup: one retention cleanup, by hand or from cron (like backup.cron).
// The same DELETE runs daily as the scheduled BullMQ job (src/jobs); the
// retention and the reasoning live in src/maintenance/cleanup.ts.
import { CLEANUPS, runCleanup } from './maintenance/cleanup.js';
import { runtimeDataSource as dataSource } from './runtime-data-source.js';

const cleanup = CLEANUPS.processedMessages;

await dataSource.initialize();
try {
  const deleted = await runCleanup(dataSource, cleanup);
  console.log(`${cleanup.name} older than ${cleanup.retention} deleted: ${deleted}`);
} finally {
  await dataSource.destroy();
}
