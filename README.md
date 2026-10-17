# m_api — Marketplace API

## Contract part: Variant B — runtime validation at the boundary

[src/](src/) is a NestJS application (Express platform under the hood) with in-memory data (4 products, 5 orders, split into `ProductsModule` and `OrdersModule`). `express-openapi-validator` is mounted as raw Express middleware in [src/main.ts](src/main.ts) and validates every request and every response against [openapi/openapi.yaml](openapi/openapi.yaml). Errors are translated to `application/problem+json` in two places: a global Nest exception filter ([src/common/problem-exception.filter.ts](src/common/problem-exception.filter.ts)) for exceptions thrown inside controllers/services, and a small fallback error-handling middleware in `main.ts` for the validator's own errors, since those are raised before Nest's router runs and never reach the filter.

## Grading

The DB scripts normally load credentials from the local store through `scripts/with-secrets.sh`. On a fresh clone there is no store, so the values come from the environment instead (`SKIP_VAULT=1`). They're the dev-only bootstrap account committed in [docker-compose.yml](docker-compose.yml), not a secret.

```bash
docker compose up -d --wait

export DB_URL=postgres://app_user@localhost:21111/shop
export SKIP_VAULT=1
export MIGRATIONS_DB_URL=postgres://admin:admin-bootstrap-only@localhost:21110/shop

cp .env.example .env
mkdir -p secrets && printf 'app-v1-password' > secrets/db_password

npm ci && npx tsc --noEmit
npm run build
npm run migrate && npm run migrate:show
npm run migrate:revert && npm run migrate
npm run seed && npm run seed
docker compose exec db psql -U admin -d shop -Atc \
  "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM products), (SELECT count(*) FROM orders), (SELECT count(*) FROM order_items)"

bash scripts/with-secrets.sh dev bash scripts/backup.sh
docker compose exec -T db pg_restore --list < "$(ls backups/shop_*.dump | tail -1)" | head
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh

npm run demo:nplus1
npm run report
npm run demo:race
npm run demo:workers
npm run demo:retry
```

Acceptance checks with this repo's values (dev-only passwords, committed in [init.sql](init.sql) and [pgbouncer/userlist.txt](pgbouncer/userlist.txt)):

| Criterion                   | Command                                                                                                          |
|-----------------------------|------------------------------------------------------------------------------------------------------------------|
| `psql` through PgBouncer    | `PGPASSWORD=app-v1-password psql -h 127.0.0.1 -p 21111 -U app_user -d shop -c 'SELECT 1'`                        |
| `pool_mode`                 | `grep -E '^pool_mode' pgbouncer/pgbouncer.ini` → `pool_mode = transaction`                                       |
| `SHOW POOLS`                | `PGPASSWORD=pgbouncer-admin-dev-only psql -h 127.0.0.1 -p 21111 -U pgbouncer_admin -d pgbouncer -c 'SHOW POOLS'` |
| Backup file name has a date | `ls backups/` → `shop_<YYYYMMDD>T<HHMMSS>Z.dump`                                                                 |
| `pg_restore --list`         | `docker compose exec -T db pg_restore --list < backups/shop_….dump`                                              |
| Restore drill               | `bash scripts/restore-drill.sh` → last line `MATCH`                                                              |
| cron line                   | `grep -cE '^(@(reboot\|daily)\|([0-9*/,-]+[[:space:]]+){4}[0-9*/,-]+)[[:space:]]+.*backup' backup.cron` → `1`    |
| RTO / RPO                   | `grep -iE 'RTO\|RPO' RESTORE-DRILL.md`                                                                           |

`pg_restore --list` runs in the container on purpose: the archive is from Postgres 16, and a host `pg_restore` older than 16 rejects it (`unsupported version (1.15) in file header`).

The row counts are `11|11|60|120` after the first seed and after the second — 10 users plus the underfunded one, 10 products plus the race product. Each demo prints its checks and exits non-zero if any fails; each resets its own preconditions, so it can be rerun. `demo:race`, `demo:workers` and `demo:retry` connect like the app does — as `app_user`, through PgBouncer on 21111 (`DB_URL` from `.env`, password from `secrets/db_password`) — see [PgBouncer](#pgbouncer).

Optional: `DEMO_COMPARE=1 npm run demo:workers` and `DEMO_COMPARE=1 npm run demo:retry` add the contrast runs — the same work without `SKIP LOCKED`, and under `READ COMMITTED` — see [Concurrency](#concurrency).

### HW#16: tests and the contract gate

Needs Docker running (Testcontainers starts its own Postgres) and the setup above: `secrets/db_password` created, `docker compose up -d --wait` (it also starts the Pact broker on 21112). `PACT_BROKER_URL` is set only on the gate commands; everything before them verifies the local pact file. Run from a clean tree: the gate's version is the commit SHA.

```bash
npm ci && npx tsc --noEmit
npm run test:integration && npm run test:integration
npm run test:e2e
npm run test:contract
npm run verify:provider
node -e 'const p=require("./pacts/web-app-m-api.json");const spec=require("fs").readFileSync("openapi/openapi.yaml","utf8");const sp=[...spec.matchAll(/^\s+(\/\S*):\s*$/gm)].map(m=>m[1]);const seg=s=>s.split("?")[0].replace(/\/+$/,"").split("/");const fit=(a,b)=>{a=seg(a);b=seg(b);return a.length===b.length&&a.every((x,i)=>/^\{[^}]+\}$/.test(x)?b[i]!=="":x===b[i])};const bad=p.interactions.filter(i=>!sp.some(x=>fit(x,i.request.path)));console.log(bad.length?"NOT IN SPEC: "+bad.map(i=>i.request.path).join(", "):"OK");process.exit(bad.length?1:0)'
grep -rn "can-i-deploy" .github/workflows/
python3 -c "import yaml;yaml.safe_load(open('.github/workflows/ci.yml'))"   # needs PyYAML

V=$(git rev-parse --short HEAD)
curl -X PUT http://127.0.0.1:21112/pacts/provider/m-api/consumer/web-app/version/$V \
  -H 'Content-Type: application/json' -d @pacts/web-app-m-api.json
PACT_BROKER_URL=http://127.0.0.1:21112 npm run verify:provider
curl "http://127.0.0.1:21112/can-i-deploy?pacticipant=web-app&version=$V&to=prod"     # "deployable":null, "unknown":1
curl -X PUT http://127.0.0.1:21112/pacticipants/m-api/versions/$V/tags/prod -H 'Content-Type: application/json'
curl "http://127.0.0.1:21112/can-i-deploy?pacticipant=web-app&version=$V&to=prod"     # "deployable":true

test -f scripts/with-secrets.sh && grep -q SKIP_VAULT scripts/with-secrets.sh && echo OK
grep -rnE "PACT_BROKER_TOKEN[\"']?[[:space:]]*[:=][[:space:]]*[\"'][^\"'$]" --include='*.ts' --include='*.js' \
  --include='*.yml' --include='*.yaml' --include='*.json' . | grep -v node_modules   # prints nothing
```

| Criterion | Command → expected |
|---|---|
| Integration, run twice | `npm run test:integration && npm run test:integration` → `PASS` lines, `Tests: 19 passed` twice |
| E2E | `npm run test:e2e` → `Tests: 6 passed` |
| Constraint tests | `grep -rniE "duplicate key\|unique\|2350[0-9]\|foreign key\|constraint" test/` → `23514`, `23503`, `23505` |
| E2E negative cases | `grep -rnE "\b(400\|404\|409\|422)\b" test/e2e/` → matches |
| Testcontainers | `grep -rn "PostgreSqlContainer" test/` → `test/integration/testkit/postgres.ts` |
| Pact file with provider states | `npm run test:contract && grep providerStates pacts/web-app-m-api.json` |
| Provider verification | `npm run verify:provider 2>&1 \| sed -E $'s/\\x1b\\[[0-9;]*m//g' \| grep -F "has a matching body (OK)"` → 2 lines |
| Pact paths exist in the spec | the `node -e` check above (`pacts/web-app-m-api.json` vs `openapi/openapi.yaml`) → `OK` |
| Broker gate | the six commands above, consumer `web-app`, provider `m-api`, broker `http://127.0.0.1:21112` → `null`/`unknown: 1`, then `true` |
| CI | `grep -rn "can-i-deploy" .github/workflows/` and the `yaml.safe_load` check |
| Vault wrapper | `test -f scripts/with-secrets.sh && grep -q SKIP_VAULT scripts/with-secrets.sh` |
| No literal token | the `PACT_BROKER_TOKEN` grep above → no output |

## TypeORM data layer

The HW#12 schema as entities in [src/entities/](src/entities/), created by the migration in [src/migrations/](src/migrations/). `synchronize: false` in [src/data-source.ts](src/data-source.ts): the schema changes only through reviewed migrations.

| Script | Does |
|---|---|
| `npm run migrate` / `migrate:show` / `migrate:revert` | apply, list, undo migrations |
| `npm run migrate:generate -- src/migrations/Name` | diff entities against the live DB into a new migration |
| `npm run seed` | deterministic, idempotent seed: 10 funded users + 1 underfunded, 10 products + the race product, 60 orders, 120 lines |
| `npm run demo:nplus1` | N+1 before/after, see [N+1](#n1) |
| `npm run report` | revenue per product via the query builder, see [Report](#report) |
| `npm run demo:race` | 50 concurrent checkouts for 10 units, see [Concurrency](#concurrency) |
| `npm run demo:workers` | 4 workers drain the job queue with `SKIP LOCKED` |
| `npm run demo:retry` | a forced `40001`, caught and retried |

All of them read `dist/`, so run `npm run build` first.

**Money is integer minor units** — `price_cents`, `total_cents`, `unit_price_cents` as `bigint` cents (`349900` = 3499.00 UAH), as the brief asks. No float anywhere; arithmetic is integer addition and multiplication. `pg` returns `bigint` as a string, so nothing is lost on the way into JS. The `Init` migration created these columns as `numeric(12,2)`; the `MoneyToMinorUnits` migration converts them in place — see [ARCHITECTURE.md](ARCHITECTURE.md) decision 6.

**`onDelete` choices:**

| Foreign key | `onDelete` | Why |
|---|---|---|
| `order_items.order_id → orders` | `CASCADE` | a line has no meaning without its order |
| `order_items.product_id → products` | `RESTRICT` | a sold product must not vanish from order history; products are soft-deleted instead (`deleted_at`) |
| `orders.user_id → users` | `RESTRICT` | orders are financial records and outlive any cleanup of users |

**Migrations:**

| Migration | What it does |
|---|---|
| `Init` | generated: every table, constraint and index. Hand-written inside it: `products_lower_name_idx` (an index on `lower(name)`) and its `CREATE STATISTICS`, which TypeORM can't describe, and `CREATE TABLE IF NOT EXISTS typeorm_metadata`, which the generator relies on for `search_vector` but doesn't emit itself |
| `MoneyToMinorUnits` | hand-written: renames `price`/`total`/`unit_price` to `*_cents` and converts them from `numeric(12,2)` to `bigint` cents in place (`round(x * 100)`). The generator sees a rename as `DROP` + `ADD`, which would lose every price. `down()` converts back exactly |
| `StockBalanceJobs` | generated, then simplified: `in_stock` boolean → `stock integer` (replaced, not converted — the generator wrote it as rename + drop + add), `users.balance_cents`, the `jobs` table with `jobs_pending_idx … WHERE status = 'new'`, and `CHECK (stock >= 0)` / `CHECK (balance_cents >= 0)` |
| `RuntimeReadOnlySchemaHistory` | hand-written: revokes `INSERT`/`UPDATE`/`DELETE` on `migrations` and `typeorm_metadata` from `app_user`, which keeps `SELECT`, so the runtime user can't rewrite schema history. `typeorm_metadata` is only touched if it exists |

`Init` is never edited once it has run anywhere; a schema change is a new migration.

## Run

Requires Node 24+ (`check:env` relies on Node's built-in TypeScript type stripping; older versions throw an unknown-extension error on `.ts` files).

```bash
npm install
npm start
```

The server listens on `http://localhost:3000`.

## Verify

Spec is valid (exit code 0):

```bash
npx @redocly/cli lint openapi/openapi.yaml
```

Spec size — operations ≥ 5, resources ≥ 2, `Idempotency-Key` required = true, description ≥ 40 characters:

```bash
npx @redocly/cli bundle openapi/openapi.yaml -o spec.json
node -e "const s=require('./spec.json'),M=['get','post','put','patch','delete'];\
const ops=Object.entries(s.paths).flatMap(([p,v])=>Object.keys(v).filter(m=>M.includes(m)).map(m=>[p,m]));\
const idem=ops.flatMap(([p,m])=>s.paths[p][m].parameters??[]).find(x=>x.in==='header'&&/idempotency-key/i.test(x.name));\
console.log('operations:',ops.length,'· resources:',new Set(Object.keys(s.paths).map(p=>p.split('/')[1])).size);\
console.log('Idempotency-Key: required =',idem?.required,'· description length =',(idem?.description??'').trim().length)"
```

Key strings declared in the spec:

```bash
grep -c 'Idempotency-Key' openapi/openapi.yaml          # ≥ 1
grep -c 'next_cursor' openapi/openapi.yaml               # ≥ 1
grep -c 'application/problem+json' openapi/openapi.yaml  # ≥ 2
```

Validator at the boundary (server must be running — `npm start`):

```bash
# no Idempotency-Key → 400, application/problem+json
curl -i -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"items":[{"product_id":1,"quantity":1}]}'

# key present, but empty items → 400 with the validator's own detail
curl -i -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 11111111-1111-4111-8111-111111111111" \
  -d '{"items":[]}'

# valid request → 201
curl -i -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 22222222-2222-4222-8222-222222222222" \
  -d '{"items":[{"product_id":1,"quantity":1}]}'
```

Both 400s above come from the spec, not from code — there is no `if` anywhere in `src/` that checks for the `Idempotency-Key` header or inspects `items`. The validator rejects both requests before they reach a controller, purely because the spec declares the header `required: true` and `items` with `minItems: 1`.

## Database: schema, seed, indexes

Main table: orders (100,000 rows). Search table: products (100,000 rows).

Bring the database up (blocks until the healthcheck passes):

```bash
docker compose up -d --wait
```

Connect (the password is the dev-only bootstrap password from [docker-compose.yml](docker-compose.yml)):

```bash
PGPASSWORD=admin-bootstrap-only psql -h localhost -p 21110 -U admin -d shop
```

**The schema has one source: the migrations in [src/migrations/](src/migrations/).** Tables, constraints, every index and the statistics object come from `npm run migrate`; `db/` only holds the HW#12 benchmark — a bulk dataset, the four queries and their recorded plans.

Sequence to reproduce the plans in [db/OPTIMIZATIONS.md](db/OPTIMIZATIONS.md) — schema, bulk seed, plans without the query indexes, plans with them:

```bash
export PGHOST=localhost PGPORT=21110 PGUSER=admin PGDATABASE=shop PGPASSWORD=admin-bootstrap-only

docker compose down -v && docker compose up -d --wait
npm run build && npm run migrate
psql -v ON_ERROR_STOP=1 -f db/seed.sql

# before: the four query indexes and the statistics object dropped inside a
# transaction that is rolled back, so the schema is untouched afterwards
for q in 1 2 3 4; do
  echo "=== q$q BEFORE ==="
  psql -q <<SQL
BEGIN;
DROP INDEX orders_user_created_idx, orders_new_created_idx, products_lower_name_idx, products_search_vector_idx;
DROP STATISTICS products_lower_name_stat;
EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q$q.sql);
ROLLBACK;
SQL
done > db/before.txt

for q in 1 2 3 4; do
  echo "=== q$q AFTER ==="
  psql -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q$q.sql)"
done > db/after.txt
```

`docker compose down -v` deletes the database volume, so every run starts from an empty database. User ids, quantities and order dates in the seed are random, so row counts for q1 and q2 differ slightly between runs; product names, prices and the search terms' match rates do not. The committed `before.txt` / `after.txt` are the HW#12 measurements, taken when the schema still came from SQL files and money was `numeric`.

| File | Purpose |
|---|---|
| [db/seed.sql](db/seed.sql) | 1,000 users, 100,000 products, 100,000 orders, 200,000 order lines on the migrated schema; ends with `VACUUM (ANALYZE)` |
| [db/queries/](db/queries/) | `q1`–`q4`, one statement per file, no semicolon, so each works inside `$(cat …)` |
| [db/OPTIMIZATIONS.md](db/OPTIMIZATIONS.md) | before/after plans, index sizes, the Ukrainian morphology limitation |

## N+1

`npm run demo:nplus1` ([src/demo-nplus1.ts](src/demo-nplus1.ts)) loads orders with their items and each item's product — two levels of relation — at two collection sizes, and counts the SQL statements TypeORM sends. Measured on the seed data:

| Strategy | n = 10 | n = 50 |
|---|---|---|
| query per order in a loop | 11 | 51 |
| `relations` (LEFT JOIN) | 1 | 1 |
| `leftJoinAndSelect` | 1 | 1 |
| `relationLoadStrategy: 'query'` | 4 | 4 |

The naive version grows with the collection (1 + N): one query for the orders, then one per order for its lines. Every fix stays constant. `relationLoadStrategy: 'query'` sends one query per relation level instead of joining — 4 here, within the 1 + 2 × 2 bound for two levels. Every strategy returns the same 10 orders and 19 lines at n = 10, so the fixes don't load less data, only fewer round-trips.

The orders are picked by id before counting, not with `take`: `take` together with `relations` makes TypeORM send a separate distinct-ids query first.

## Report

`npm run report` ([src/report.ts](src/report.ts)): revenue per product, via `createQueryBuilder().getRawMany()`.

**Repository or QueryBuilder:** the repository while the result is an entity or an entity graph — CRUD, a filtered list, an order with its lines. The query builder the moment the result isn't an entity: aggregates, `GROUP BY`, report rows. The line is the shape of what comes back, not how hard the query is.

The report uses `.withDeleted()`: revenue is history, and a soft-deleted product still had its sales. Without it, the query builder adds `deleted_at IS NULL` just as `find()` does, and past revenue would change the day a product is discontinued.

⚠️ `.withDeleted()` must come **before** the joins. Each `innerJoin()` writes the `deleted_at IS NULL` condition into its `ON` clause when it's called, so a later `.withDeleted()` leaves the joined products filtered. Checked by soft-deleting a product: with the call after the joins it vanished from the report (total 2102160.00 → 1310184.00 UAH, measured before the switch to cents); before the joins it stays.

Revenue comes back as `revenue_cents`, in cents.

## Concurrency

Checkout ([src/checkout/checkout.ts](src/checkout/checkout.ts)), the job workers ([src/workers/job-worker.ts](src/workers/job-worker.ts)) and the retry wrapper ([src/common/transaction-retry.ts](src/common/transaction-retry.ts)), each proved by a demo with a contrast run:

| Demo | With the fix | Without |
|---|---|---|
| `demo:race` — 50 checkouts, stock 10 | 10 of 50 succeed, stock 0, no negative rows, 0 retries; balance exact, no orphan orders | — the guarded update is the only path |
| `demo:workers` — 4 workers, 20 jobs × 100 ms | 560 ms vs 2000 ms sequential, `w1=5 w2=5 w3=5 w4=5`, 0 processed twice | without `SKIP LOCKED`: 2131 ms, `w3=0` — correct, but no faster than one worker |
| `demo:retry` — two read-modify-writes on one balance | `REPEATABLE READ`: one `40001` caught on B and retried, final 102000 as expected | `READ COMMITTED`: 97000, no error — a lost update |

**Atomic `UPDATE` rather than `SELECT … FOR UPDATE`.** The whole decision — is there enough stock, is the balance enough — fits in one SQL expression, so the check and the change are a single statement: `UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 AND deleted_at IS NULL RETURNING price_cents, name`. There's no window between reading and writing for another transaction to slip into. Under `READ COMMITTED` a writer that had to wait for the row re-checks the `WHERE` against the newly committed version, so the 11th buyer sees `stock = 0` and matches nothing. The row lock is held only from the update to the commit. What makes the guard safe is checking the affected-row count: zero rows isn't an error from Postgres, it's the guard refusing, and an unchecked refusal would look like a success. `FOR UPDATE` would earn its place only if the decision needed reads or logic that don't fit in one expression.

**Why the retry catches only `40001` and `40P01`.** Those two mean Postgres rolled your transaction back because of another one — a serialization conflict or a deadlock — and running the whole transaction again will most likely succeed. Every other error either fails identically the next time (a `CHECK` or unique violation) or isn't safe to repeat blindly, like a connection lost during `COMMIT`, where you can't know whether it committed.

**Other choices a reviewer should find:**
- **Lock order: stock before balance, everywhere.** With one order, two checkouts can never wait on each other in a cycle, so they can't deadlock.
- **The receipt job is inserted in the checkout transaction.** It commits with the order or not at all, and the receipt is sent later by a worker — so a retried checkout can't send two.
- **A worker holds its transaction while it works.** If it crashes mid-job, the transaction rolls back, the row lock disappears, and the job is `new` again for another worker. The claim is `ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED` — the `LIMIT` matters, because TypeORM's `getOne()` doesn't add one.

## Data layer ops

How to start the database, why the app goes through PgBouncer in transaction mode, how backups are taken and checked, and how to recover from one.

### How to start

```bash
docker compose up -d --wait
```

| Service                                    | Host port | Who connects                                                                     |
|--------------------------------------------|-----------|----------------------------------------------------------------------------------|
| `db` (Postgres 16)                         | 21110     | migrations, seed, reports, admin work (`MIGRATIONS_DB_URL`, as the schema owner) |
| `pgbouncer` (PgBouncer 1.26)               | 21111     | the app and the concurrency demos (`DB_URL`, as `app_user`)                      |
| `pact-broker` (+ its own `pact-broker-db`) | 21112     | contract publishing and `can-i-deploy` (`PACT_BROKER_URL`); never the app's db   |

`--wait` returns once both are healthy. PgBouncer's healthcheck runs a query through the pool, so it's healthy only when Postgres is reachable behind it.

### PgBouncer

The app's runtime connections go through PgBouncer ([pgbouncer/pgbouncer.ini](pgbouncer/pgbouncer.ini), port 21111) in **transaction mode**: a server connection is lent to a client for one transaction and then returned, so many app connections share a few Postgres connections (`default_pool_size = 10`). Passwords aren't copied into PgBouncer: it looks each login up in Postgres through `pgbouncer.get_auth()` ([init.sql](init.sql)), so `rotate.sh` needs no PgBouncer step. The function refuses superusers and returns nothing for a password past its `VALID UNTIL`.

**What transaction mode breaks:** anything that lives on the server connection longer than one transaction, because the next transaction may run on a different connection, and the next client may inherit this one. That covers session `SET`, `LISTEN`, SQL-level `PREPARE`, session advisory locks, `WITH HOLD` cursors, and temp tables with `ON COMMIT PRESERVE ROWS` / `DELETE ROWS`.

**Why this app is unaffected** (driver audit, query logging on): `dataSource.transaction('REPEATABLE READ', …)` sends `START TRANSACTION` then `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`, so the isolation level is scoped to that one transaction, and the next one is back to `read committed`. TypeORM sends no startup parameters (`options`, `statement_timeout`) and runs no session `SET` on connect. Nothing in `src/` uses `LISTEN`, `PREPARE`, advisory locks, cursors or temp tables. node-postgres only uses named prepared statements when a query is given a `name`, and nothing here names one; PgBouncer 1.26 would handle protocol-level ones anyway (`max_prepared_statements` defaults to 200).

**Why migrations bypass it:** `MIGRATIONS_DB_URL` connects to Postgres directly (21110) as the schema owner. PgBouncer can't log in a superuser here, because `get_auth()` returns nothing for one, and DDL is admin work that doesn't need pooling. `app_user` only has `SELECT, INSERT, UPDATE, DELETE` on the tables and `USAGE` on sequences, via `ALTER DEFAULT PRIVILEGES` in `init.sql`, so every table a migration creates is covered automatically. The exception is TypeORM's own bookkeeping (`migrations`, `typeorm_metadata`): the `RuntimeReadOnlySchemaHistory` migration leaves `app_user` `SELECT` only there, so the runtime user can't tamper with schema history.

`DB_URL` carries no password (the app reads it from `secrets/db_password`), so it's config in `.env`; the vault's `MIGRATIONS_DB_URL` deliberately stays direct to Postgres.

**Where the app reaches it:** here, `localhost:21111` from the host. Another container on the compose network uses `pgbouncer:6432` (the container port, not the host mapping). In production, `DB_URL` points at PgBouncer's internal service address, never at Postgres.

**Experiments** (`demo:workers` runs 20 jobs × 100 ms; pool size changed live via `SET default_pool_size = N` on the admin console and restored with `RELOAD`):

| Setting                  | Demo           | Result                                      | `SHOW POOLS` during the run            |
|--------------------------|----------------|---------------------------------------------|----------------------------------------|
| `default_pool_size = 10` | `demo:workers` | 566 ms                                      | —                                      |
| `default_pool_size = 2`  | `demo:workers` | 1079 ms                                     | `cl_active=2 cl_waiting=2 sv_active=2` |
| `default_pool_size = 1`  | `demo:retry`   | fails after 5 s: no `40001`, balance 105000 | `cl_active=1 cl_waiting=1 sv_active=1` |

- **Pool size 2:** only 2 transactions run at once and the other 2 workers queue in PgBouncer, so the time doubles: ≈ 20 × 100 ms / 2.
- **Pool size 1:** B holds the only server connection inside its transaction while it waits for A, and A waits in PgBouncer's queue for that same connection. Postgres sees no lock conflict, so nothing detects the deadlock; B's own 5 s timeout ends it, and only A's deposit lands (105000 instead of 102000).
- **Session advisory lock:** `pg_advisory_lock(42)`, then quit. The lock stays held by an idle server connection that no client owns. Concurrent `pg_try_advisory_lock(42)` calls return `t` on that connection (advisory locks are re-entrant, so unrelated clients "acquire" a held lock) and `f` on any other. Which answer a client gets depends on which server connection it lands on. Cleanup: `pg_terminate_backend(pid)` as admin.

### Backup

```bash
bash scripts/with-secrets.sh dev bash scripts/backup.sh          # MIGRATIONS_DB_URL from the vault
MIGRATIONS_DB_URL=postgres://admin:admin-bootstrap-only@localhost:21110/shop \
  SKIP_VAULT=1 bash scripts/with-secrets.sh dev bash scripts/backup.sh   # or from the shell
```

[scripts/backup.sh](scripts/backup.sh) writes `backups/shop_<UTC timestamp>.dump` (for example `shop_20261017T184352Z.dump`), a `pg_dump -Fc` archive, and prints its path as the last line. It connects with `MIGRATIONS_DB_URL`, the schema owner's direct connection, and takes host, port, user and password from it, so the database can be anywhere this machine reaches (cron on another host included). Not `DB_URL`: that's `app_user` through PgBouncer, and `app_user` can't read the `pgbouncer` schema, while `pg_dump` needs a session that transaction pooling doesn't keep. The Postgres tools run in a throwaway `postgres:<major>-alpine` container whose major version matches the server's (`pg_dump` must be at least that new); a `localhost` URL is pointed at the Docker host. It runs from any directory.

- **Fails instead of writing a bad backup:** it exits non-zero if the database isn't reachable, if `orders` is missing or empty ("database is empty: run migrate and seed first"), or if `pg_dump` fails. The archive is written under a temporary name and only renamed once everything succeeded; a failed run leaves nothing in `backups/`.
- **Control values:** `<dump>.check` holds each table's row count plus `sum(total_cents)` of `orders`, **read back from the dump's own data** (`pg_restore --data-only`), so they describe exactly the dump's snapshot, not the database a moment before or after. The restore drill compares the restored database against this file, table by table.
- **Check an archive** with the container's Postgres 16 tools: `docker compose exec -T db pg_restore --list < backups/shop_….dump`. The host's `pg_restore` 14 rejects it (`unsupported version (1.15) in file header`): an archive can only be read by a `pg_restore` at least as new as the `pg_dump` that wrote it.
- **The dump has no roles.** Roles are cluster-wide and `pg_dump` covers one database, but the dump's `OWNER TO admin` and its grants to `app_user` and `pgbouncer_auth` still name them. Restoring into a fresh Postgres needs those roles created first.
- Dumps contain real data: `backups/` is in `.gitignore` and `.dockerignore`, and the files are created owner-only (`umask 077`).

**Schedule:** [backup.cron](backup.cron) runs it nightly at 03:00 host time through `with-secrets.sh prod`, appending output to `backups/backup.log`. Install by appending, since `crontab backup.cron` replaces the whole crontab: `(crontab -l 2>/dev/null; cat backup.cron) | crontab -`, after changing `/opt/m_api` to the repo's path. The file's header covers `/etc/cron.d/` on Linux and the machine identity production needs for the vault.

- **RPO:** up to 24 h of data lost with a nightly run, up to 48 h if one night's run fails silently.
- **Retention:** nothing deletes old dumps yet; that belongs with S3 lifecycle rules (#26).
- **Off-host copies:** none yet. A dump on the same machine doesn't survive losing the machine.

**Restore drill:** `bash scripts/restore-drill.sh` restores the newest dump into a throwaway container, from the Postgres major version in the dump's own header (so it works with `db` down), and prints `MATCH` when every value in the dump's `.check` matches. See [RESTORE-DRILL.md](RESTORE-DRILL.md) for the last run and what a real recovery needs first.

### How to recover

The drill proves a dump restores; this is the procedure for bringing the real database back from one. It isn't scripted. Practise it on a copy, never on the dev volume.

1. **Stop the app** and anything else that writes, so nothing lands in the old database or half-way through the restore.
2. **Start a fresh Postgres** from the same image as `db`, reachable by PgBouncer. Here that means the compose network, for example `docker run -d --name shop-restored --network m_api_default -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=… -e POSTGRES_DB=shop postgres:16-alpine`.
3. **Create the roles** from [init.sql](init.sql)'s role section, with the real passwords from the vault: `CREATE ROLE app_user LOGIN PASSWORD …`, `GRANT CONNECT ON DATABASE shop TO app_user`, `CREATE ROLE pgbouncer_auth LOGIN PASSWORD …`. Only that section: the dump brings the `pgbouncer` schema, `get_auth()` and the default privileges itself, and running the rest of `init.sql` would conflict with it. `pgbouncer_auth`'s password must match `pgbouncer/userlist.txt`, or PgBouncer can't look up logins.
4. **Restore the chosen dump:** `docker exec -i shop-restored pg_restore -U admin -d shop --no-owner --single-transaction < backups/shop_….dump`. Any error rolls the whole restore back.
5. **Check the control values:** each table's `count(*)`, and `sum(total_cents)` of `orders`, must equal the dump's `.check` (one `table count` line per table).
6. **Point PgBouncer at it:** in [pgbouncer/pgbouncer.ini](pgbouncer/pgbouncer.ini), change `[databases]` to `shop = host=shop-restored port=5432 dbname=shop`, then run `RELOAD` on the admin console. The app's `DB_URL` doesn't change.
7. **Start the app** and check it: `GET /db` returns `app_user`, and `SHOW POOLS` shows the `shop` pool in use.

## Testing

```bash
npm run test:integration   # repositories against real Postgres: SQL behaviour, constraints, grants
npm run test:e2e           # the whole app over HTTP: real AppModule, no overrides, production setup
npm run test:contract      # the consumer's expectations: writes pacts/web-app-m-api.json
npm run verify:provider    # the real provider against that pact
```

Every script builds first (`tsc -p tsconfig.test.json` into `dist-test/`), and Jest runs the compiled JavaScript.

**Isolation.** Tests are isolated with `TRUNCATE … RESTART IDENTITY CASCADE` before each one, not a transaction rolled back after it. `checkout()` opens and commits its own transactions and takes row locks, and the E2E tests run the app on its own pool, so a per-test rollback can't contain either. It's the same split Django makes between `TestCase` and `TransactionTestCase`. The table list comes from TypeORM's entity metadata, so the `migrations` table is never touched, and it runs as admin: `app_user` has no `TRUNCATE`, which a test checks.

**The test database.** Each test file starts a throwaway Postgres container (Testcontainers) built like the compose `db`: the same image, admin as the superuser, `init.sql` applied first (its roles and default privileges), then the real migrations, the same list the TypeORM CLI runs. The code under test connects as `app_user`, so a missing grant fails a test; only setup and `reset()` run as admin ([test/integration/testkit/](test/integration/testkit/)). Tests never touch the compose `db` or PgBouncer.

The E2E tests ([test/e2e/](test/e2e/)) boot the real `AppModule`, with no provider overrides and the same `configureApp()` as `main.ts`, on the same kind of container. `DB_URL` is pointed at the container **before** `AppModule` is imported (a dynamic `import()` in `beforeAll`): `ConfigModule` reads the environment on first import, and a static import would pick up `.env`, which points at the dev database. `beforeAll` also checks the app's connection port and stops if it isn't the container's.

**Contract (Pact).** An imaginary frontend, `web-app`, consumes `m-api` (the names are fixed: pact file, verifier, broker and can-i-deploy all use them). Its consumer test ([test/contract/](test/contract/)) drives a small `ProductsClient`, not raw `fetch`, and records two interactions on `GET /products/{id}`: `product 42 exists` → 200 with `id`, `title`, `price_cents`, `in_stock` (matchers, not exact values), and `product 999 does not exist` → 404 `application/problem+json`. `verify:provider` runs the real app (container, migrations, `configureApp()`, the same boot as E2E) against that file; each provider state starts from `reset()`, so verification is repeatable. `pacts/` is gitignored: `test:contract` (and CI) generates it, so a stale file can't pass for a current one.

The spec and the contract are two separate nets. When the provider renamed `title` to `name`, the OpenAPI response validator caught it first: the app answered 500 (`/response must have required property 'title'`), and Pact reported `expected 200 but was 500` before comparing any body. When the consumer asked for a field the provider doesn't return (`currency`), the spec had nothing to say and Pact caught it: `Actual map is missing the following keys: currency`.

### Contract gate (Pact broker)

`docker compose up -d --wait` also starts a Pact broker on 21112, with its own Postgres. `verify:provider` switches on `PACT_BROKER_URL`: unset, it verifies the local `pacts/` file; set, it pulls the pact from the broker and publishes the result under `PROVIDER_VERSION`, or the short git SHA when that's unset. Through the vault, `bash scripts/with-secrets.sh dev npm run verify:provider` gets `PACT_BROKER_URL` from `.secrets/infisical.env`; without one, `SKIP_VAULT=1 PACT_BROKER_URL=http://127.0.0.1:21112 npm run verify:provider` takes it from the shell. The local broker has no authentication; `PACT_BROKER_TOKEN` is passed on only when set, and never lives in the repo.

The gate, as run (consumer and provider version both `0d3d994`, the commit under test):

```bash
docker compose up -d --wait                                   # pact-broker healthy
npm run test:contract
curl -X PUT http://127.0.0.1:21112/pacts/provider/m-api/consumer/web-app/version/0d3d994 \
  -H 'Content-Type: application/json' -d @pacts/web-app-m-api.json          # 201
PACT_BROKER_URL=http://127.0.0.1:21112 npm run verify:provider              # exit 0, prints "as m-api version 0d3d994"
curl -H 'Accept: application/hal+json' \
  "http://127.0.0.1:21112/can-i-deploy?pacticipant=web-app&version=0d3d994&to=prod"
curl -X PUT http://127.0.0.1:21112/pacticipants/m-api/versions/0d3d994/tags/prod \
  -H 'Content-Type: application/json'                                       # 201
curl -H 'Accept: application/hal+json' \
  "http://127.0.0.1:21112/can-i-deploy?pacticipant=web-app&version=0d3d994&to=prod"
```

`can-i-deploy` before the tag (the response's `summary`). No provider version is tagged `prod` yet, so the broker can't say yes or no:

```json
{"deployable": null, "reason": "There is no verified pact between version 0d3d994 of web-app and the latest version of m-api with tag prod (no such version exists)", "success": 0, "failed": 0, "unknown": 1}
```

After tagging the verified provider version `prod`:

```json
{"deployable": true, "reason": "All required verification results are published and successful", "success": 1, "failed": 0, "unknown": 0}
```

The third answer, from a provider that broke the contract (`title` renamed, verified as version `broken`, tagged `prod`): `{"deployable": false, … "with tag prod (broken) failed", "failed": 1}`. The tag must go on exactly the version the verifier published; "latest with tag prod" means the newest such **version**, not the newest tag.

The brief's grader uses tags (`tags/prod`, `to=prod`), so this follows it; current Pact docs prefer `record-deployment` with environments, which CI uses. Locally the verifier selects `{ latest: true }`, because a plain `curl` publish carries no branch; CI publishes with one and sets `PROVIDER_BRANCH`, so there it selects `{ matchingBranch: true }`: the pact this commit's branch just published.

### CI ([.github/workflows/ci.yml](.github/workflows/ci.yml))

Two jobs, on every pull request and every push to `main`. `tests` runs `test:integration` and `test:e2e`. `contract`:

1. starts a broker from this same `docker-compose.yml`, unless a persistent one is configured (below);
2. runs the consumer test and publishes the pact with the Pact CLI (`pactfoundation/pact-cli`): consumer version = commit SHA, branch = the PR's or pushed branch;
3. verifies the provider and publishes the result under the same SHA. A failed verification is published but doesn't stop the job here;
4. **the gate:** `can-i-deploy --pacticipant web-app --version <sha> --pacticipant m-api --version <sha>`, i.e. is this commit's consumer verified against this commit's provider. It exits 1 on a failed or missing verification, failing the job.

With a persistent broker (`PACT_BROKER_URL` and `PACT_BROKER_TOKEN` as GitHub secrets), two more steps run: `can-i-deploy --pacticipant web-app --version <sha> --to-environment production`, which checks against the provider version actually recorded in production, and, only for a push to `main`, `record-deployment` of `m-api` to `production`. A job never records its own commit as deployed and then asks about it. Without the secrets, the job falls back to its own broker on `127.0.0.1:21112` (not `localhost`, which can resolve to IPv6).

The gate, rehearsed locally with the same CLI command against the local broker:

```
good commit:        Computer says yes \o/   web-app | gate-good-1   | m-api | gate-good-1   | true   → exit 0
provider breaks it: Computer says no ¯\_(ツ)_/¯   web-app | gate-broken-1 | m-api | gate-broken-1 | false  → exit 1
never verified:     Computer says no ¯\_(ツ)_/¯                                                    → exit 1
```

The first green CI run (commit `e2f2045`, before the gate was reworked to the version pair) printed `Computer says yes \o/` with `web-app e2f2045… | m-api e2f2045… | true`. On a throwaway branch with `title` renamed to `name` (commit `bf9fd7a`, same earlier design), **Contract (Pact)** failed at verification: the response validator answered 500 (`/response must have required property 'title'`) and Pact reported `expected 200 but was 500`. With the current job, that verification is published and `can-i-deploy` is the step that fails, as in the rehearsal above. **Integration and E2E tests** failed on that branch too: integration passed (19/19, the repositories don't see API field names), and E2E failed on `GET /products` for the same 500.

CI uses environments (`record-deployment`, `--to-environment`) rather than the tags of the local gate. The limit: a broker that lives for one job can only answer for this commit's pair; checking a consumer against what is really deployed needs the persistent broker.

### Known gaps

- **Idempotency-Key replays are kept in memory:** per process, lost on restart, and two simultaneous requests with the same key can both create an order. A table with a unique key on the idempotency key is the durable version.
- **`app-v1-password` lives in two places:** `init.sql` (the testkit reads it from there and hands it to the test app through `DB_PASSWORD_FILE`) and the Grading setup's `secrets/db_password` for running the app itself.
- **The provider version is the commit SHA,** which only identifies the code on a clean tree: uncommitted changes get verified and published under `HEAD`'s SHA.
- **No persistent broker is configured yet:** until `PACT_BROKER_URL`/`PACT_BROKER_TOKEN` secrets point at one (PactFlow, or a self-hosted broker), CI checks only this commit's consumer/provider pair, not the consumer against what is actually in production.

## Configuration

Environment variables are validated on startup by [src/config/env.schema.ts](src/config/env.schema.ts) via a zod schema, wired into `ConfigModule.forRoot({ validate })` in [src/app.module.ts](src/app.module.ts). A missing or malformed variable makes the process exit immediately with a non-zero code and a message naming every broken variable — never a runtime failure on the first request.

| Variable                     | Source                   | Required for                                       |
|------------------------------|--------------------------|----------------------------------------------------|
| `PORT`                       | `.env`                   | — (default `3000`)                                 |
| `DB_URL`                     | `.env`                   | the app, `demo:race`, `demo:workers`, `demo:retry` |
| DB password (not an env var) | `secrets/db_password`    | the app and the same three demos                   |
| `MIGRATIONS_DB_URL`          | `.secrets/infisical.env` | `migrate*`, `seed`, `demo:nplus1`, `report`        |

- **`PORT`:** the port the HTTP server listens on. Template for `.env`: `.env.example`.
- **`DB_URL`:** Postgres connection string (`postgres://user@host:port/database`), pointing at PgBouncer (`localhost:21111`), not Postgres — see [PgBouncer](#pgbouncer). Any password segment is ignored — a password embedded in an env var can't be rotated without a restart, which defeats the point below, so the pool always gets its password from `secrets/db_password` instead.
- **DB password:** a gitignored secret file (HW#11), rotated by `rotate.sh`. Read fresh on every new connection, so the password rotates without a restart. See [Database password](#database-password).
- **`MIGRATIONS_DB_URL`:** connection string for the TypeORM CLI and DB scripts, as the schema owner (migrations run DDL, which `app_user` can't). Loaded by `scripts/with-secrets.sh` from the gitignored store. Not read by the app, so it isn't in `.env.example` — `check:env` would reject it. See [DB scripts and secrets](#db-scripts-and-secrets).

Copy [.env.example](.env.example) to `.env` and adjust as needed:

```bash
cp .env.example .env
```

`npm run check:env` verifies `.env.example` stays in sync with the schema (fails with exit 1 if a variable is added to one but not the other).

### DB scripts and secrets

The DB scripts (`npm run migrate`, `migrate:show`, `migrate:revert`, `migrate:generate`, `seed`, `demo:nplus1`, `report`) run through [scripts/with-secrets.sh](scripts/with-secrets.sh), which loads `.secrets/infisical.env` into the environment and then `exec`s the command. Create the store once (the URL below is the dev-only bootstrap account already committed in [docker-compose.yml](docker-compose.yml), not a leaked credential — a real environment's store holds its own):

```bash
mkdir -p .secrets
echo 'MIGRATIONS_DB_URL=postgres://admin:admin-bootstrap-only@localhost:21110/shop' > .secrets/infisical.env
```

Without the store, export the variable yourself and skip it:

```bash
MIGRATIONS_DB_URL=postgres://… SKIP_VAULT=1 npm run migrate
```

[src/data-source.ts](src/data-source.ts) has no default: if `MIGRATIONS_DB_URL` is missing it throws instead of connecting somewhere unexpected. The scripts read `dist/`, so run `npm run build` first.

Generate a migration from the entities (the name goes after `--`):

```bash
npm run build
npm run migrate:generate -- src/migrations/AddOrders
```

### Database password

The Postgres password is never read from an environment variable. The app's TypeORM DataSource ([src/db/app-data-source.ts](src/db/app-data-source.ts)) reads it from `secrets/db_password` on every new connection (TypeORM's `password` option accepts an async function, which it hands to the `pg` pool underneath) — that file is gitignored and never copied into the Docker image.

Local Postgres for development — one line to bring it up, one line to connect (both work on a clean clone, no setup beyond this):

```bash
docker compose up -d
psql "postgres://app_user:app-v1-password@localhost:21110/shop" -c "select current_user"
```

`app_user`'s password there comes straight from [init.sql](init.sql), which is committed — this line needs nothing beyond the repo itself. `init.sql` only runs against an empty volume — `docker compose up -d` on an existing volume won't re-seed anything.

The **app itself** doesn't take that password from the connection string — it reads it from `secrets/db_password`, which is gitignored and so doesn't exist yet on a fresh clone. Create it once, matching `init.sql`'s starting password, before running the app against this database:

```bash
mkdir -p secrets && printf 'app-v1-password' > secrets/db_password
```

⚠️ `docker compose down -v` wipes that volume, so Postgres reverts to `init.sql`'s original password on the next `up`, while `secrets/db_password` keeps whatever `rotate.sh` last wrote there. That mismatch looks exactly like broken rotation (`password authentication failed`) but is really just a stale file — reset it back to `app-v1-password` after a volume wipe.

### Rotating the database password

`rotate.sh` rotates `app_user`'s password with **no service restart**:

```bash
bash rotate.sh
```

It runs, in order: `ALTER ROLE` in Postgres → write the new password to `secrets/db_password` → terminate old `app_user` connections via `pg_terminate_backend`. The next request opens a fresh connection using the new password automatically, since the pool re-reads the secret file per connection.

Verify it worked without a restart:

```bash
curl -s localhost:3000/health   # note uptimeSec
bash rotate.sh
curl -s localhost:3000/db       # 200 — new password already works
curl -s localhost:3000/health   # uptimeSec is LARGER — process never restarted
```

## Docker

```bash
docker build -t m_api .
docker run --rm -p 3000:3000 m_api
```

The multi-stage [Dockerfile](Dockerfile) only copies `dist/`, `package*.json`, `.env.example`, and `openapi/openapi.yaml` into the runner stage — no `.env`, no `secrets/`, no `ENV` instructions with credentials. `.dockerignore` also excludes `.git`, so none of it reaches the build context in the first place.

## Structure

| File / folder | Purpose |
|---|---|
| `openapi/openapi.yaml` | spec: 2 resources (`/products`, `/orders`), 5 operations, cursor pagination, Idempotency-Key, problem+json |
| `src/main.ts` | bootstraps Nest, mounts `express-openapi-validator` and the fallback error handler |
| `src/products/`, `src/orders/` | one Nest module (controller + service) per resource, in-memory data |
| `src/common/` | shared `problem+json` builder and the global exception filter |
| `src/config/env.schema.ts` | zod schema for all env vars, fail-fast `validate()` |
| `src/db/` | `DbModule`/`DbService`/`DbController` — the app's DataSource (`app-data-source.ts`), `/db` health query |
| `src/health-check/` | dependency-free `/health` module (`{ uptimeSec }`) |
| `src/entities/` | TypeORM entities for the HW#12 schema; `index.ts` exports them and the list the DataSource registers |
| `src/migrations/` | the only schema source: `Init` (generated, hand-written parts marked), `MoneyToMinorUnits` (hand-written), `StockBalanceJobs` (generated, simplified), `RuntimeReadOnlySchemaHistory` (hand-written) |
| `src/data-source.ts` | DataSource for the CLI and DB scripts: `synchronize: false`, URL from `MIGRATIONS_DB_URL` |
| `src/runtime-data-source.ts` | DataSource for the concurrency demos: `app_user` through PgBouncer, like the app |
| `src/seed.ts` | deterministic, idempotent seed |
| `src/demo-nplus1.ts`, `src/common/query-count-logger.ts` | N+1 demo and the logger that counts its queries |
| `src/report.ts`, `src/reports/` | report runner and the query-builder report itself |
| `src/seed-fixtures.ts` | seeded rows the demos look up: the race product, its buyer, the underfunded user, the retry subject, the seeded balance |
| `src/checkout/` | `checkout()` — one `READ COMMITTED` transaction of guarded atomic updates — and its typed rejections |
| `src/common/transaction-retry.ts` | `inTransactionWithRetry`: retries the whole transaction on `40001`/`40P01`, bounded, full jitter, `label` + `onRetry` |
| `src/workers/` | the job worker: claim with `SKIP LOCKED`, work and complete in one transaction |
| `src/demo-race.ts`, `src/demo-workers.ts`, `src/demo-retry.ts` | the three concurrency demos |
| `scripts/backup.sh` | `pg_dump -Fc` via `MIGRATIONS_DB_URL` into `backups/`, with per-table control values read from the dump, see [Backup](#backup) |
| `scripts/restore-drill.sh`, `RESTORE-DRILL.md` | restores the newest dump into a throwaway container and checks it; the last run's record |
| `backup.cron` | nightly 03:00 schedule for `scripts/backup.sh`, with install notes |
| `scripts/with-secrets.sh` | loads `.secrets/infisical.env` and runs the command; `SKIP_VAULT=1` skips the store |
| `.env.example` | env var contract, kept in sync with the schema via `npm run check:env` |
| `scripts/check-env-example.js` | diffs `.env.example` against the schema in both directions |
| `secrets/db_password` | gitignored password file, read fresh on every new DB connection |
| `docker-compose.yml`, `init.sql` | local Postgres and PgBouncer for development; roles, grants, `get_auth()` |
| `pgbouncer/` | PgBouncer config (`pgbouncer.ini`) and the two logins it keeps itself (`userlist.txt`) |
| `rotate.sh` | rotates the DB password with no service restart |
| `package.json` | ESM (`"type": "module"`), `scripts.start` runs `nest build && node dist/main.js` |
| `.gitignore`, `.dockerignore` | `.env`/`secrets`/`backups` excluded from both git and the Docker build context |
