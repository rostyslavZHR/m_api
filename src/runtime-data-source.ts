import 'reflect-metadata';
import { createAppDataSource } from './db/app-data-source.js';

// The concurrency demos run on the app's own connection: app_user through
// PgBouncer. data-source.ts (admin) can't: PgBouncer's get_auth() refuses
// superusers.
const url = process.env.DB_URL;
if (!url) {
  throw new Error('DB_URL is not set — create .env from .env.example, or export it');
}

export const runtimeDataSource = createAppDataSource(url);
