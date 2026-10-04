# m_api — Marketplace API

## Contract part: Variant B — runtime validation at the boundary

[src/](src/) is a NestJS application (Express platform under the hood) with in-memory data (4 products, 5 orders, split into `ProductsModule` and `OrdersModule`). `express-openapi-validator` is mounted as raw Express middleware in [src/main.ts](src/main.ts) and validates every request and every response against [openapi/openapi.yaml](openapi/openapi.yaml). Errors are translated to `application/problem+json` in two places: a global Nest exception filter ([src/common/problem-exception.filter.ts](src/common/problem-exception.filter.ts)) for exceptions thrown inside controllers/services, and a small fallback error-handling middleware in `main.ts` for the validator's own errors, since those are raised before Nest's router runs and never reach the filter.

## Grading

The DB scripts normally load credentials from the local store through `scripts/with-secrets.sh`. On a fresh clone there is no store, so the values come from the environment instead (`SKIP_VAULT=1`). They're the dev-only bootstrap account committed in [docker-compose.yml](docker-compose.yml), not a secret.

```bash
docker compose up -d --wait
export MIGRATIONS_DB_URL=postgres://admin:admin-bootstrap-only@localhost:21110/shop
export SKIP_VAULT=1    # the grader has no access to the store

npm ci && npx tsc --noEmit
npm run build
npm run migrate && npm run migrate:show
npm run migrate:revert && npm run migrate
npm run seed && npm run seed
docker compose exec db psql -U admin -d shop -Atc \
  "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM products), (SELECT count(*) FROM orders), (SELECT count(*) FROM order_items)"
npm run demo:nplus1
npm run report
```

The row counts are `10|10|60|120` after the first seed and after the second.

## TypeORM data layer

The HW#12 schema as entities in [src/entities/](src/entities/), created by the migration in [src/migrations/](src/migrations/). `synchronize: false` in [src/data-source.ts](src/data-source.ts): the schema changes only through reviewed migrations.

| Script | Does |
|---|---|
| `npm run migrate` / `migrate:show` / `migrate:revert` | apply, list, undo migrations |
| `npm run migrate:generate -- src/migrations/Name` | diff entities against the live DB into a new migration |
| `npm run seed` | deterministic, idempotent seed: 10 users, 10 products, 60 orders, 120 lines |
| `npm run demo:nplus1` | N+1 before/after, see [N+1](#n1) |
| `npm run report` | revenue per product via the query builder, see [Report](#report) |

All of them read `dist/`, so run `npm run build` first.

**Money is `numeric(12,2)`, not integer minor units.** The brief asks for integer kopecks; this project deliberately keeps `numeric(12,2)` (`price`, `total`, `unit_price`). Both are exact — neither is a float — but `numeric` keeps the scale in the column type, where integer cents keep it only in a `_cents` naming convention every reader has to know. It was chosen in the HW#12 review and is recorded as [ARCHITECTURE.md](ARCHITECTURE.md) decision 6. In code, `pg` returns `numeric` as a string, so nothing is lost on the way in; arithmetic is done in integer cents (see `src/seed.ts`), never on JS floats.

**`onDelete` choices:**

| Foreign key | `onDelete` | Why |
|---|---|---|
| `order_items.order_id → orders` | `CASCADE` | a line has no meaning without its order |
| `order_items.product_id → products` | `RESTRICT` | a sold product must not vanish from order history; products are soft-deleted instead (`deleted_at`) |
| `orders.user_id → users` | `RESTRICT` | orders are financial records and outlive any cleanup of users |

**Hand-written parts of the migration:** `products_lower_name_idx` (an index on `lower(name)`) and the `CREATE STATISTICS` for it, which TypeORM can't describe, and `CREATE TABLE IF NOT EXISTS typeorm_metadata`, which the generator relies on for `search_vector` but doesn't emit itself.

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

Full sequence to reproduce the numbers in [db/OPTIMIZATIONS.md](db/OPTIMIZATIONS.md) — schema, seed, plans before, indexes, plans after:

```bash
export PGHOST=localhost PGPORT=21110 PGUSER=admin PGDATABASE=shop PGPASSWORD=admin-bootstrap-only

docker compose down -v && docker compose up -d --wait
psql -v ON_ERROR_STOP=1 -f db/schema.sql
psql -v ON_ERROR_STOP=1 -f db/seed.sql

for q in 1 2 3 4; do
  echo "=== q$q BEFORE ==="
  psql -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q$q.sql)"
done > db/before.txt

psql -v ON_ERROR_STOP=1 -f db/indexes.sql

for q in 1 2 3 4; do
  echo "=== q$q AFTER ==="
  psql -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q$q.sql)"
done > db/after.txt

echo "=== q4 AFTER (warm) ===" >> db/after.txt
psql -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q4.sql)" >> db/after.txt
```

`docker compose down -v` deletes the database volume, so every run starts from an empty database. User ids, quantities and order dates in the seed are random, so row counts for q1 and q2 differ slightly between runs; product names, prices and the search terms' match rates do not.

| File | Purpose |
|---|---|
| [db/schema.sql](db/schema.sql) | `users`, `products` (with a stored `tsvector`), `orders`, `order_items` |
| [db/seed.sql](db/seed.sql) | 1,000 users, 100,000 products, 100,000 orders, 200,000 order lines; ends with `VACUUM (ANALYZE)` |
| [db/queries/](db/queries/) | `q1`–`q4`, one statement per file, no semicolon, so each works inside `$(cat …)` |
| [db/indexes.sql](db/indexes.sql) | one index per query: composite, partial, expression, GIN |
| [db/OPTIMIZATIONS.md](db/OPTIMIZATIONS.md) | before/after plans, index sizes, the Ukrainian morphology limitation |

Money is stored as `numeric(12,2)`, not as integer minor units: both are exact, and `numeric` keeps the scale in the column type instead of a `_cents` naming convention. This departs from the brief on purpose; see [ARCHITECTURE.md](ARCHITECTURE.md) decision 6.

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

⚠️ `.withDeleted()` must come **before** the joins. Each `innerJoin()` writes the `deleted_at IS NULL` condition into its `ON` clause when it's called, so a later `.withDeleted()` leaves the joined products filtered. Checked by soft-deleting a product: with the call after the joins it vanished from the report (total 2102160.00 → 1310184.00); before the joins it stays.

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
| `src/migrations/` | generated migrations, with the hand-written parts marked |
| `src/data-source.ts` | DataSource for the CLI and DB scripts: `synchronize: false`, URL from `MIGRATIONS_DB_URL` |
| `src/seed.ts` | deterministic, idempotent seed |
| `src/demo-nplus1.ts`, `src/common/query-count-logger.ts` | N+1 demo and the logger that counts its queries |
| `src/report.ts`, `src/reports/` | report runner and the query-builder report itself |
| `scripts/with-secrets.sh` | loads `.secrets/infisical.env` and runs the command; `SKIP_VAULT=1` skips the store |
| `.env.example` | env var contract, kept in sync with the schema via `npm run check:env` |
| `scripts/check-env-example.js` | diffs `.env.example` against the schema in both directions |
| `secrets/db_password` | gitignored password file, read fresh on every new DB connection |
| `docker-compose.yml`, `init.sql` | local Postgres for development |
| `rotate.sh` | rotates the DB password with no service restart |
| `package.json` | ESM (`"type": "module"`), `scripts.start` runs `nest build && node dist/main.js` |
| `.gitignore`, `.dockerignore` | `.env`/`secrets` excluded from both git and the Docker build context |
