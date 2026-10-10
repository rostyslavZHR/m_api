# m_api — Marketplace API

## Contract part: Variant B — runtime validation at the boundary

[src/](src/) is a NestJS application (Express platform under the hood) with in-memory data (4 products, 5 orders, split into `ProductsModule` and `OrdersModule`). `express-openapi-validator` is mounted as raw Express middleware in [src/main.ts](src/main.ts) and validates every request and every response against [openapi/openapi.yaml](openapi/openapi.yaml). Errors are translated to `application/problem+json` in two places: a global Nest exception filter ([src/common/problem-exception.filter.ts](src/common/problem-exception.filter.ts)) for exceptions thrown inside controllers/services, and a small fallback error-handling middleware in `main.ts` for the validator's own errors, since those are raised before Nest's router runs and never reach the filter.

## Grading

The DB scripts normally load credentials from the local store through `scripts/with-secrets.sh`. On a fresh clone there is no store, so the values come from the environment instead (`SKIP_VAULT=1`). They're the dev-only bootstrap account committed in [docker-compose.yml](docker-compose.yml), not a secret.

```bash
docker compose up -d --wait
export MIGRATIONS_DB_URL=postgres://admin:admin-bootstrap-only@localhost:21110/shop
export SKIP_VAULT=1

npm ci && npx tsc --noEmit
npm run build
npm run migrate && npm run migrate:show
npm run migrate:revert && npm run migrate
npm run seed && npm run seed
docker compose exec db psql -U admin -d shop -Atc \
  "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM products), (SELECT count(*) FROM orders), (SELECT count(*) FROM order_items)"
npm run demo:nplus1
npm run report
npm run demo:race
npm run demo:workers
npm run demo:retry
```

The row counts are `11|11|60|120` after the first seed and after the second — 10 users plus the underfunded one, 10 products plus the race product. Each demo prints its checks and exits non-zero if any fails; each resets its own preconditions, so it can be rerun.

Optional: `DEMO_COMPARE=1 npm run demo:workers` and `DEMO_COMPARE=1 npm run demo:retry` add the contrast runs — the same work without `SKIP LOCKED`, and under `READ COMMITTED` — see [Concurrency](#concurrency).

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

## Configuration

Environment variables are validated on startup by [src/config/env.schema.ts](src/config/env.schema.ts) via a zod schema, wired into `ConfigModule.forRoot({ validate })` in [src/app.module.ts](src/app.module.ts). A missing or malformed variable makes the process exit immediately with a non-zero code and a message naming every broken variable — never a runtime failure on the first request.

| Variable | Source | Required | Description |
|---|---|---|---|
| `PORT` | `.env` (template: `.env.example`) | No (default `3000`) | Port the HTTP server listens on. |
| `DB_URL` | `.env` (template: `.env.example`) | Yes | Postgres connection string (`postgres://user@host:port/database`). Any password segment is ignored — a password embedded in an env var can't be rotated without a restart, which defeats the point below, so the pool always gets its password from `secrets/db_password` instead. |
| DB password (not an env var) | `secrets/db_password` — gitignored secret file (HW#11), rotated by `rotate.sh` | Yes, to run the app against Postgres | Read fresh on every new connection, so the password rotates without a restart. See [Database password](#database-password). |
| `MIGRATIONS_DB_URL` | `.secrets/infisical.env` — gitignored, loaded by `scripts/with-secrets.sh` | Yes, for `migrate*`, `seed`, `demo:nplus1`, `report` | Connection string for the TypeORM CLI and DB scripts, as the schema owner (migrations run DDL, which `app_user` can't). Not read by the app, so it isn't in `.env.example` — `check:env` would reject it. See [DB scripts and secrets](#db-scripts-and-secrets). |

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

The Postgres password is never read from an environment variable. `DbService`'s connection pool ([src/db/db.provider.ts](src/db/db.provider.ts)) reads it from `secrets/db_password` on every new connection (via `pg.Pool`'s `password` option, which accepts an async function) — that file is gitignored and never copied into the Docker image.

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
| `src/db/` | `DbModule`/`DbService`/`DbController` — pg pool factory, `/db` health query |
| `src/health-check/` | dependency-free `/health` module (`{ uptimeSec }`) |
| `src/entities/` | TypeORM entities for the HW#12 schema; `index.ts` exports them and the list the DataSource registers |
| `src/migrations/` | the only schema source: `Init` (generated, hand-written parts marked), `MoneyToMinorUnits` (hand-written), `StockBalanceJobs` (generated, simplified) |
| `src/data-source.ts` | DataSource for the CLI and DB scripts: `synchronize: false`, URL from `MIGRATIONS_DB_URL` |
| `src/seed.ts` | deterministic, idempotent seed |
| `src/demo-nplus1.ts`, `src/common/query-count-logger.ts` | N+1 demo and the logger that counts its queries |
| `src/report.ts`, `src/reports/` | report runner and the query-builder report itself |
| `src/seed-fixtures.ts` | seeded rows the demos look up: the race product, its buyer, the underfunded user, the retry subject, the seeded balance |
| `src/checkout/` | `checkout()` — one `READ COMMITTED` transaction of guarded atomic updates — and its typed rejections |
| `src/common/transaction-retry.ts` | `inTransactionWithRetry`: retries the whole transaction on `40001`/`40P01`, bounded, full jitter, `label` + `onRetry` |
| `src/workers/` | the job worker: claim with `SKIP LOCKED`, work and complete in one transaction |
| `src/demo-race.ts`, `src/demo-workers.ts`, `src/demo-retry.ts` | the three concurrency demos |
| `scripts/with-secrets.sh` | loads `.secrets/infisical.env` and runs the command; `SKIP_VAULT=1` skips the store |
| `.env.example` | env var contract, kept in sync with the schema via `npm run check:env` |
| `scripts/check-env-example.js` | diffs `.env.example` against the schema in both directions |
| `secrets/db_password` | gitignored password file, read fresh on every new DB connection |
| `docker-compose.yml`, `init.sql` | local Postgres for development |
| `rotate.sh` | rotates the DB password with no service restart |
| `package.json` | ESM (`"type": "module"`), `scripts.start` runs `nest build && node dist/main.js` |
| `.gitignore`, `.dockerignore` | `.env`/`secrets` excluded from both git and the Docker build context |
