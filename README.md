# m_api — Marketplace API

## Contract part: Variant B — runtime validation at the boundary

[src/](src/) is a NestJS application (Express platform under the hood) with in-memory data (4 products, 5 orders, split into `ProductsModule` and `OrdersModule`). `express-openapi-validator` is mounted as raw Express middleware in [src/main.ts](src/main.ts) and validates every request and every response against [openapi/openapi.yaml](openapi/openapi.yaml). Errors are translated to `application/problem+json` in two places: a global Nest exception filter ([src/common/problem-exception.filter.ts](src/common/problem-exception.filter.ts)) for exceptions thrown inside controllers/services, and a small fallback error-handling middleware in `main.ts` for the validator's own errors, since those are raised before Nest's router runs and never reach the filter.

## Run

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

## Structure

| File / folder | Purpose |
|---|---|
| `openapi/openapi.yaml` | spec: 2 resources (`/products`, `/orders`), 5 operations, cursor pagination, Idempotency-Key, problem+json |
| `src/main.ts` | bootstraps Nest, mounts `express-openapi-validator` and the fallback error handler |
| `src/products/`, `src/orders/` | one Nest module (controller + service) per resource, in-memory data |
| `src/common/` | shared `problem+json` builder and the global exception filter |
| `package.json` | ESM (`"type": "module"`), `scripts.start` runs `nest start` |
| `.gitignore` | `spec.json` and `dist/` are generated, not committed |
