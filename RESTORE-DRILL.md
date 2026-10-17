# Restore drill

[scripts/restore-drill.sh](scripts/restore-drill.sh) restores the newest `backups/shop_*.dump` into a Postgres container created for that run. The image's major version is read from the dump's own header (`Dumped from database version: 16.x`), so the drill needs no running `db`, which is what's missing in an outage. It then compares the restored database against the dump's `.check` file, which `backup.sh` read back from the dump's own data: each table's row count plus `sum(total_cents)` of `orders`, and prints `MATCH` (exit 0) or `MISMATCH` (exit 1). The container and its anonymous volume are removed on every exit, so every run starts from nothing. The dev database and its compose volume are never touched.

```bash
SKIP_VAULT=1 bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

## Last run

Run with `db` and `pgbouncer` **stopped**, to show the drill doesn't depend on them.

| Field        | Value                                                         |
|--------------|---------------------------------------------------------------|
| Date         | 2026-10-17T18:45:03Z                                          |
| Dump         | `shop_20261017T184401Z.dump`, 24637 bytes                     |
| Image        | `postgres:16-alpine`, from the dump's header                  |
| Restore only | 223 ms                                                        |
| End to end   | 2606 ms (container start, readiness, roles, restore, compare) |
| Result       | `MATCH`, 8 of 8 values                                        |

| Control value               | Expected (`.check`) | Restored  |
|-----------------------------|---------------------|-----------|
| `public.jobs`               | 220                 | 220       |
| `public.migrations`         | 4                   | 4         |
| `public.order_items`        | 230                 | 230       |
| `public.orders`             | 170                 | 170       |
| `public.orders.total_cents` | 210326000           | 210326000 |
| `public.products`           | 11                  | 11        |
| `public.typeorm_metadata`   | 1                   | 1         |
| `public.users`              | 11                  | 11        |

Afterwards no container carried the `m_api.drill=1` label.

## RTO and RPO

**RTO (measured, technical): 2.6 s end to end, 0.22 s restore.** This covers what the drill does: start a fresh Postgres, wait for it, create the roles, restore, compare. It doesn't carry over to a real outage:

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
- The control values count rows and sum one money column; they would miss a restore that kept every row but changed values elsewhere.
- The drill assumes the `postgres:<major>-alpine` image; a server built from another variant would need its own image name.

## Roles: what a real recovery needs first

The dump has no roles: roles are cluster-wide, and `pg_dump` backs up one database. Its grants still name `app_user` and `pgbouncer_auth`. Restored into a fresh Postgres without them, `pg_restore` logged 16 `role … does not exist` errors (`errors ignored on restore: 16`), yet the data loaded and the control values matched. A check on data alone would have passed while every grant was missing. With `--single-transaction` the same restore rolled back completely (0 tables).

The drill creates both roles as `NOLOGIN` before restoring, so the grants restore faithfully with no passwords involved. A real recovery recreates them from `init.sql`'s role section, with real passwords, or from a `pg_dumpall --globals-only` backup, which isn't taken yet. `--no-owner` is kept as well. The container's `POSTGRES_USER=admin` means the owner role exists anyway.

## Failure cases tested

Each exited 1, printed no `MATCH`, and left no container behind.

| Case                                  | Result                                                                                                         |
|---------------------------------------|----------------------------------------------------------------------------------------------------------------|
| Wrong control value (`.check` edited) | `MISMATCH`, every value printed with the differing one marked `✗` (`public.users 12 → 11 ✗`)                    |
| Dump without `.check`                 | `no control values for this dump (….check is missing)`                                                         |
| Damaged dump (first 5000 bytes)       | `pg_restore: error: could not read from input file: end of file`, then `pg_restore failed …: nothing compared` |
| No dumps                              | `no dumps in backups/: run backup.sh first`                                                                    |
| Leftover container from a killed run  | swept at the start of the next run, which then printed `MATCH`                                                 |
| `.check` in the old one-line format   | `….check is in an old format: rerun backup.sh`                                                                 |
