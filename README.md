# m_api — Marketplace API

## Contract part: Variant B — runtime validation at the boundary

[src/](src/) is a NestJS application (Express platform under the hood) with in-memory data (4 products, 5 orders, split into `ProductsModule` and `OrdersModule`). `express-openapi-validator` is mounted as raw Express middleware in [src/main.ts](src/main.ts) and validates every request and every response against [openapi/openapi.yaml](openapi/openapi.yaml). Errors are translated to `application/problem+json` in two places: a global Nest exception filter ([src/common/problem-exception.filter.ts](src/common/problem-exception.filter.ts)) for exceptions thrown inside controllers/services, and a small fallback error-handling middleware in `main.ts` for the validator's own errors, since those are raised before Nest's router runs and never reach the filter.

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

## Configuration

Environment variables are validated on startup by [src/config/env.schema.ts](src/config/env.schema.ts) via a zod schema, wired into `ConfigModule.forRoot({ validate })` in [src/app.module.ts](src/app.module.ts). A missing or malformed variable makes the process exit immediately with a non-zero code and a message naming every broken variable — never a runtime failure on the first request.

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default `3000`) | Port the HTTP server listens on. |
| `DB_URL` | Yes | Postgres connection string (`postgres://user@host:port/database`). Any password segment is ignored — a password embedded in an env var can't be rotated without a restart, which defeats the point below, so the pool always gets its password from `secrets/db_password` instead. |

Copy [.env.example](.env.example) to `.env` and adjust as needed:

```bash
cp .env.example .env
```

`npm run check:env` verifies `.env.example` stays in sync with the schema (fails with exit 1 if a variable is added to one but not the other).

### Database password

The Postgres password is never read from an environment variable. `DbService`'s connection pool ([src/db/db.provider.ts](src/db/db.provider.ts)) reads it from `secrets/db_password` on every new connection (via `pg.Pool`'s `password` option, which accepts an async function) — that file is gitignored and never copied into the Docker image.

Local Postgres for development:

```bash
docker compose up -d
```

This seeds `app_user` with the password from [init.sql](init.sql) (`app-v1-password`), matching the starting contents of `secrets/db_password`. `init.sql` only runs against an empty volume — `docker compose up -d` on an existing volume won't re-seed anything.

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
| `.env.example` | env var contract, kept in sync with the schema via `npm run check:env` |
| `scripts/check-env-example.js` | diffs `.env.example` against the schema in both directions |
| `secrets/db_password` | gitignored password file, read fresh on every new DB connection |
| `docker-compose.yml`, `init.sql` | local Postgres for development |
| `rotate.sh` | rotates the DB password with no service restart |
| `package.json` | ESM (`"type": "module"`), `scripts.start` runs `nest build && node dist/main.js` |
| `.gitignore`, `.dockerignore` | `.env`/`secrets` excluded from both git and the Docker build context |
