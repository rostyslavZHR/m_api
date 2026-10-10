# Restore drill

[scripts/restore-drill.sh](scripts/restore-drill.sh) restores the newest `backups/shop_*.dump` into a Postgres container created for that run, from the same image the running `db` uses. It then compares the restored `orders` against the dump's `.check` file, written by `backup.sh` at backup time, and prints `MATCH` (exit 0) or `MISMATCH` (exit 1). The container and its anonymous volume are removed on every exit, so every run starts from nothing. The dev database and its compose volume are never touched.

```bash
SKIP_VAULT=1 bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

## Last run

| | |
|---|---|
| Date | 2026-10-10T22:29:57Z |
| Dump | `shop_20261010T222901Z.dump`, 23958 bytes |
| Image | `postgres:16-alpine` |
| Restore only | 230 ms |
| End to end | 2271 ms (container start, readiness, roles, restore, compare) |
| Control values | expected `140\|210296000`, restored `140\|210296000` |
| Result | `MATCH` |

A second run straight after printed `MATCH` again (restore 207 ms, end to end 2115 ms). Afterwards no container carried the `m_api.drill=1` label, the volume list was identical to before, and the dev database's `orders` still read `140|210296000`.

## RTO and RPO

**RTO (measured, technical): 2.3 s end to end, 0.23 s restore.** This covers what the drill does: start a fresh Postgres, wait for it, create the roles, restore, compare. It doesn't carry over to a real outage:

- The database is 24 KB. Restore time grows with data size and index builds, and a database of tens of GB takes hours, not seconds.
- A real outage adds what the drill skips: noticing it, deciding to restore, setting up a server, recreating roles with real passwords, the restore itself, verifying, and pointing the app at the new database.
- The last step is short because the app goes through PgBouncer: change `host=` under `[databases]` in `pgbouncer/pgbouncer.ini` and run `RELOAD`. The app's `DB_URL` doesn't change.

**RTO (realistic estimate): ~30–60 min**, counted from when someone starts working on it. Rough breakdown: deciding to restore and picking the dump, 5–15 min; a new Postgres from the same image, 5 min; roles from `init.sql`'s role section with the real passwords from the vault, 5–10 min; restore, seconds at this size; verifying (this drill's comparison plus a request through the app), 5–10 min; repointing PgBouncer, 2 min. Human decisions dominate, not the restore. Detection isn't in that number: nothing alerts yet, so the outage lasts until someone notices it, which at night can take hours.

**RPO: up to 24 h** (nightly at 03:00), and **up to 48 h** if one night's run fails silently, because nothing alerts on a failed backup yet.

## Known gaps

- No off-host copy: a dump on the same machine doesn't survive losing the machine (S3, #26).
- No retention: nothing deletes old dumps (S3 lifecycle rules, #26).
- No globals backup: roles and their passwords aren't backed up (`pg_dumpall --globals-only`).
- No alerting on a failed backup or a failed drill (#29).
- The control values are read just before `pg_dump`, not from the same snapshot as the dump.
- The drill checks one table: per-table row counts at backup time would catch a restore that lost another table.

## Roles: what a real recovery needs first

The dump has no roles: roles are cluster-wide, and `pg_dump` backs up one database. Its grants still name `app_user` and `pgbouncer_auth`. Restored into a fresh Postgres without them, `pg_restore` logged 16 `role … does not exist` errors (`errors ignored on restore: 16`), yet the data loaded and the control values matched. A check on data alone would have passed while every grant was missing. With `--single-transaction` the same restore rolled back completely (0 tables).

The drill creates both roles as `NOLOGIN` before restoring, so the grants restore faithfully with no passwords involved. A real recovery recreates them from `init.sql`'s role section, with real passwords, or from a `pg_dumpall --globals-only` backup, which isn't taken yet. `--no-owner` is kept as well. The container's `POSTGRES_USER=admin` means the owner role exists anyway.

## Failure cases tested

Each exited 1, printed no `MATCH`, and left no container behind.

| Case | Result |
|---|---|
| Wrong control value (`.check` edited) | `MISMATCH`, both values printed |
| Dump without `.check` | `no control values for this dump (….check is missing)` |
| Damaged dump (first 5000 bytes) | `pg_restore: error: could not read from input file: end of file`, then `pg_restore failed …: nothing compared` |
| No dumps | `no dumps in backups/: run backup.sh first` |
| Leftover container from a killed run | swept at the start of the next run, which then printed `MATCH` |
