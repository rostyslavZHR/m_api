# Architecture Decision Record — Marketplace API

**Project:** m_api · **Status:** living document, revised as the project develops

## Domain

A minimal marketplace. Buyers browse a product catalogue and place orders
containing one or more products.

Deliberately narrow: enough surface to exercise pagination, idempotency,
transactional order creation and catalogue search, without the breadth of a real
marketplace. Sellers are explicitly out of scope — products belong to the
catalogue, not to anyone (decision 12).

## User stories

**Buyer**
- browse the product catalogue
- search the catalogue by words in a product's name or description
- view one product's details
- place an order containing several products, each with a quantity
- retry a failed order submission without being charged twice
- list their own orders, newest first, a page at a time
- view one order and its line items

**Operations**
- list orders in a given status — pending orders needing fulfilment
- see orders created within a period
- discontinue a product without breaking the orders that reference it

## Entities

| Entity | Holds | Relationships |
|---|---|---|
| `users` | who places orders | one-to-many → `orders` |
| `products` | catalogue: name, description, price, availability | one-to-many → `order_items` |
| `orders` | one purchase: status, total, timestamp | belongs to a user; one-to-many → `order_items` |
| `order_items` | one product line: quantity, price and name at purchase | belongs to an order and a product |

`order_items` exists because an order contains many products and a product
appears in many orders — neither table can hold that link. It carries its own
data (quantity, snapshotted price and name), which is typical of a join table —
and why it's an explicit entity rather than a `@ManyToMany` (decision 27).

## Decisions

### API

| # | Decision | Reasoning |
|---|---|---|
| 1 | REST over HTTP, JSON | the API is consumed by a web client |
| 2 | **Planned, not implemented:** OpenAPI generated from decorators, not hand-maintained | the code would be the single source of truth; a separate YAML drifts from the implementation the first time either changes. The trade: the generated document faithfully describes the code, including where the code is wrong — a contract check in CI restores the second opinion. **Not done yet:** the app still validates every request and response against the hand-written `openapi/openapi.yaml` (`express-openapi-validator` in `src/main.ts`), so 2a is what runs today |
| 2a | Spec-first: hand-written `openapi/openapi.yaml` | **current**, until 2 is implemented. The starting point, enforced at runtime by `express-openapi-validator` |
| 3 | Errors as `application/problem+json` (RFC 9457) | one error shape across every endpoint, machine-readable `type` |
| 4 | Cursor pagination for order lists, not offset | stable under concurrent inserts; no page drift, no duplicate or skipped rows |
| 5 | `Idempotency-Key` required on order creation | a retried POST must not create a second order |

### Data

| # | Decision | Reasoning |
|---|---|---|
| 6 | Money as **`numeric(12,2)`** (`price`, `total`, `unit_price`) | exact decimal, so no floating-point rounding, and the scale lives in the type rather than in a `_cents` suffix every reader has to know about. Avoids the `money` type, whose precision depends on a server locale setting. Deliberately departs from the brief's "integer in minor units": both are exact, and `numeric` was chosen in the HW#12 review. In JS, `pg` returns it as a string, so no precision is lost; arithmetic needs a decimal library or integer conversion, not `Number` |
| ~~6a~~ | ~~Money as integer cents (`bigint`)~~ | **superseded by 6.** Exact, but the scale was encoded only in column names |
| 7 | **`order_items` stores `unit_price` at purchase time** | an order is a record of what happened. Computing the total from today's prices would silently rewrite the value of every past order when a price changes |
| 8 | `order_items` also stores **`product_name`** at purchase time | the line is then self-contained: an order stays fully readable regardless of what happens to the product row afterwards |
| 9 | **Order total stored on the order**, not summed on read | the total is a fact about the transaction, not a derived value — it can include discounts, shipping and rounding that no sum of lines reproduces. Also avoids an aggregate join on every order list. Guarded by order lines being immutable after creation |
| 10 | **Soft delete for products** (`deleted_at`) | products are discontinued, not erased; old orders and revenue reporting must still resolve them. Cost: every catalogue query needs `WHERE deleted_at IS NULL`, mitigated by a partial index on the live rows. With TypeORM the filter is automatic (`@DeleteDateColumn`); reports turn it off on purpose (decision 26) |
| 11 | Order status as **`text` + `CHECK`**, not a Postgres `enum` | changing the allowed set is an ordinary transactional migration. Postgres enums can't drop or rename values without rewriting the type, and their ordering is fixed at creation. Storage saving is irrelevant at this scale |
| 12 | **No sellers.** Products have no owner | keeps the domain narrow. Revisit only if the stories require it |
| 13 | `users` as a real table with a foreign key from `orders` | without it `orders.user_id` references nothing and there's no referential integrity. No credentials yet — authentication is not in scope |
| 14 | `timestamptz` everywhere, never `timestamp` | `timestamp` records a reading on a clock, `timestamptz` records an instant; the difference is invisible in the schema and wrong twice a year |
| 15 | `GENERATED ALWAYS AS IDENTITY`, not `serial` | `serial` is a macro with awkward sequence-ownership semantics; identity is the standard replacement |

### Runtime

| # | Decision | Reasoning |
|---|---|---|
| 16 | NestJS on Express | DI, modules and lifecycle hooks; the platform the later work assumes |
| 17 | Postgres as the datastore | the domain is inherently relational — orders, lines and products are joins |
| 18 | **One Postgres instance** for the project | a second service means two ports, two credential sets and a permanent question of which one you're connected to |
| 19 | Config validated at startup with a zod schema | a broken environment stops the process with a named variable, rather than failing on the first request that touches it |
| 20 | DB password read from a **file**, not an env var | env is a snapshot taken at process start and can't be changed from outside; a file can be re-read per connection, so the password rotates without a restart |
| 21 | Secrets never in git or in a Docker image layer | both are permanent and readable without running anything |

### Data access

| # | Decision | Reasoning |
|---|---|---|
| 22 | **TypeORM** as the data layer, entities in `src/entities/` | entities, relations and migrations in code instead of loose SQL files, typed results, and relation loading without hand-written joins. The Nest services still use in-memory data; they move onto these entities next |
| 23 | **`synchronize: false`; the schema changes only through migrations** | `synchronize` diffs and applies on every start — a rename can become drop + add, with no review and no record. A migration is a file that's read before it runs, applied in order on every database, recorded in the `migrations` table, and reversible through `down()`. Migrations are generated from the entities; what TypeORM can't describe (the `lower(name)` index and its `CREATE STATISTICS`) is hand-written into the same file. So is the first line of the initial migration, `CREATE TABLE IF NOT EXISTS typeorm_metadata`: the generated `up()` inserts the `search_vector` expression into that table but never creates it, relying on the CLI having done so first. Don't remove it as redundant — the `IF NOT EXISTS` makes the migration work whether or not the CLI got there first |
| 24 | **`onDelete`: `CASCADE` from order to lines, `RESTRICT` for product and user** | a line has no meaning without its order, so it goes with it. A sold product and a user with orders must not vanish from history: deleting them is refused, and products are soft-deleted instead (decision 10) |
| 25 | **Repository for entities, query builder for reports** | the repository while the result is an entity or an entity graph — CRUD, filtered lists, an order with its lines. `createQueryBuilder().getRawMany()` the moment the result isn't an entity: aggregates, `GROUP BY`, report rows. Reports live in `src/reports/` as functions taking a `DataSource` |
| 26 | **Reports include soft-deleted products** (`.withDeleted()`) | revenue is history: a discontinued product still had its sales, and dropping it would change past totals the day it's discontinued. The call must come before the joins, or the joined products stay filtered |
| 27 | `order_items` as an **explicit entity**, not `@ManyToMany` | the link carries data (quantity, price and name at purchase), which a `@ManyToMany` junction table can't hold. Composite primary key `(order_id, product_id)` |
| 28 | Migration and script credentials from the **secret store**, through `scripts/with-secrets.sh` | `src/data-source.ts` has no host or password, only `MIGRATIONS_DB_URL` from the environment. Every DB script runs through the wrapper, so the store is the default path. `SKIP_VAULT=1` is the CI path, where the runner supplies the environment. The CLI connects as the schema owner, since `app_user` can't run DDL |

## Queries the schema must serve

Derived from the user stories — these are what the data layer is designed for,
and what its indexes exist for:

- a user's orders, newest first, paged by cursor
- orders filtered by status (operations: everything pending)
- orders created within a date range
- catalogue search by words in name or description
- one order with its line items
- catalogue listing, excluding discontinued products

## Open questions

- **Idempotency key storage.** Currently in-process, which is correct for one
  instance and wrong for two — a key held by instance A is invisible to B, and a
  restart loses all of them. Belongs in a table with the claim/finish state
  machine, once there's transactional logic to attach it to
- **Order status as a state machine.** Currently a flat set of allowed values
  with no rules about transitions. Whether `shipped → pending` should be
  impossible at the database level, or enforced in the service, is undecided
- **Are order lines truly immutable?** Decision 9 assumes so. If an order can be
  edited after creation, the stored total needs a rule for staying in sync
- **Product availability** is currently a boolean. Whether it becomes real stock
  tracking depends on whether any story needs "how many are left"
- **Authentication.** No credentials on `users`, no auth on any endpoint. The
  shape of it — sessions, JWT, where keys live — is not yet decided

## Revision log

| Stage | Change |
|---|---|
| Initial | Domain, user stories, entities. Decisions 1, 3, 4, 5, 6 — API contract, error format, pagination, idempotency |
| After the Nest migration | Decisions 16, 19, 20, 21 — framework, config validation, secret handling. Decision 2 reversed: the spec is generated from decorators rather than hand-maintained |
| Data layer design | Decisions 7–15, 17, 18 — price and name snapshots, stored total, soft delete, status modelling, no sellers, real `users` table, type choices |
| HW#12 review | Decision 6 changed: money is `numeric(12,2)`, superseding integer cents (6a) |
| TypeORM data layer | Decisions 22–28 — ORM, migrations instead of `synchronize`, `onDelete` strategy, repository vs query builder, soft-deleted rows in reports, explicit join entity, credentials from the store. Decision 2 corrected: it was recorded as done, but the code still validates against the hand-written spec, so it's marked as planned and 2a as current |
