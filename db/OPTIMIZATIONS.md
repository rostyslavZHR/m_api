# Optimizations — Marketplace API

> Measured in HW#12, when the schema came from `db/schema.sql` and the query indexes
> from `db/indexes.sql`, and money was `numeric(12,2)`. Since HW#13 the schema has one
> source, the migrations in `src/migrations/`, which also create these indexes; money is
> integer cents. The plans and numbers below are the recorded HW#12 results. The
> README's *Database* section has the sequence that reproduces them on the migrated schema.

## Baseline: dataset and storage

Seeded by `db/seed.sql`: 1,000 users, 100,000 products, 100,000 orders,
200,000 order lines. No indexes beyond primary keys and `order_items_product_id_idx`,
which backs a foreign key rather than any of the four queries (see [Foreign key index](#foreign-key-index)).

`products` after seeding and `VACUUM (ANALYZE)`:

| Measure | Size |
|---|---|
| Total (`pg_total_relation_size`) | 35 MB |
| Heap (`pg_relation_size`) | 32 MB |
| Indexes (`pg_indexes_size`, primary key only) | 2.2 MB |
| `search_vector` data (`sum(pg_column_size(search_vector))`) | 15 MB — ~48% of the heap |

The stored `tsvector` column nearly doubles the table's footprint. That is the
cost of `GENERATED ... STORED`: the vector is kept on every row rather than
computed at query time. The GIN index built on it later adds to this.

## Before and after indexes

Clean rebuild (HW#12): `docker compose down -v`, `db/schema.sql`, `db/seed.sql`, plans captured, then
`db/indexes.sql` (which ended with `ANALYZE`), plans captured again — both files since replaced by the migrations. Raw output is kept in
[`before.txt`](before.txt) and [`after.txt`](after.txt). q4's after-plan is the warm second run.

```sh
for q in 1 2 3 4; do
  psql -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q$q.sql)"
done
```

| Query | Buffers | Execution time | Plan after | Index size |
|---|---|---|---|---|
| q1 | 1,605 → 35 | 6.218 → 0.160 ms | Bitmap scan on `orders_user_created_idx` | 3.0 MB |
| q2 | 1,605 → 776 | 6.834 → 1.604 ms | Bitmap scan on `orders_new_created_idx` | 128 kB |
| q3 | 4,150 → 4 | 36.460 → 0.095 ms | Index Scan on `products_lower_name_idx` | 5.7 MB |
| q4 | 4,156 → 377 | 12.623 → 1.206 ms | Bitmap scan on `products_search_vector_idx` | 6.2 MB |

Buffers are the stable comparison; timings are single runs and vary by a few ms between runs.
The four indexes add 15.1 MB in total. Their cost on writes is not measured here.

### q1

One user's orders in a date range, newest first. Index: `orders_user_created_idx`. [`db/queries/q1.sql`](queries/q1.sql)

`orders_user_created_idx` entered the plan as a Bitmap Index Scan, the Seq Scan on `orders` disappeared (the Sort stayed), and buffers fell from 1,605 to 35: 6 in the index, 26 for the heap pages holding the 26 matching rows, and 3 at the Sort node.

Before:

```
                                                                                  QUERY PLAN                                                                                   
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=3352.58..3352.64 rows=25 width=28) (actual time=6.186..6.188 rows=26 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 26kB
   Buffers: shared hit=1605
   ->  Seq Scan on orders  (cost=0.00..3352.00 rows=25 width=28) (actual time=0.545..6.161 rows=26 loops=1)
         Filter: ((created_at >= '2026-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-06-01 00:00:00+00'::timestamp with time zone) AND (user_id = 42))
         Rows Removed by Filter: 99974
         Buffers: shared hit=1602
 Planning:
   Buffers: shared hit=100
 Planning Time: 0.306 ms
 Execution Time: 6.218 ms
(12 rows)
```

After:

```
                                                                                       QUERY PLAN                                                                                        
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=99.88..99.94 rows=26 width=28) (actual time=0.116..0.117 rows=26 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 26kB
   Buffers: shared hit=32 read=3
   ->  Bitmap Heap Scan on orders  (cost=4.75..99.27 rows=26 width=28) (actual time=0.039..0.095 rows=26 loops=1)
         Recheck Cond: ((user_id = 42) AND (created_at >= '2026-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-06-01 00:00:00+00'::timestamp with time zone))
         Heap Blocks: exact=26
         Buffers: shared hit=29 read=3
         ->  Bitmap Index Scan on orders_user_created_idx  (cost=0.00..4.74 rows=26 width=0) (actual time=0.029..0.029 rows=26 loops=1)
               Index Cond: ((user_id = 42) AND (created_at >= '2026-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-06-01 00:00:00+00'::timestamp with time zone))
               Buffers: shared hit=3 read=3
 Planning:
   Buffers: shared hit=143 read=2
 Planning Time: 0.472 ms
 Execution Time: 0.160 ms
(15 rows)
```

The Sort stayed because Postgres chose a bitmap scan and sorted the 26 rows in memory, rather
than walking the index backwards in `created_at` order. `created_at` has almost no correlation
with physical row order (0.00 in `pg_stats`), so the 26 rows sit on 26 different pages, and a
bitmap scan reads them in physical order. Sorting 26 rows costs next to nothing.

### q2

Orders with status `'new'` since a date. Index: `orders_new_created_idx`. [`db/queries/q2.sql`](queries/q2.sql)

`orders_new_created_idx` entered the plan as a Bitmap Index Scan, the Seq Scan on `orders` disappeared (the Sort stayed), and buffers fell from 1,605 to 776: 7 in the index, 766 in the heap because the 1,709 matching orders are spread over 766 pages, and 3 at the Sort node.

Before:

```
                                                   QUERY PLAN                                                    
-----------------------------------------------------------------------------------------------------------------
 Sort  (cost=3191.33..3195.50 rows=1669 width=31) (actual time=6.614..6.706 rows=1709 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 147kB
   Buffers: shared hit=1605
   ->  Seq Scan on orders  (cost=0.00..3102.00 rows=1669 width=31) (actual time=0.361..6.231 rows=1709 loops=1)
         Filter: ((created_at >= '2026-06-01 00:00:00+00'::timestamp with time zone) AND (status = 'new'::text))
         Rows Removed by Filter: 98291
         Buffers: shared hit=1602
 Planning:
   Buffers: shared hit=100
 Planning Time: 0.324 ms
 Execution Time: 6.834 ms
(12 rows)
```

After:

```
                                                                 QUERY PLAN                                                                 
--------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=1813.23..1817.36 rows=1653 width=31) (actual time=1.404..1.489 rows=1709 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 147kB
   Buffers: shared hit=769 read=7
   ->  Bitmap Heap Scan on orders  (cost=37.09..1724.87 rows=1653 width=31) (actual time=0.254..1.044 rows=1709 loops=1)
         Recheck Cond: ((created_at >= '2026-06-01 00:00:00+00'::timestamp with time zone) AND (status = 'new'::text))
         Heap Blocks: exact=766
         Buffers: shared hit=766 read=7
         ->  Bitmap Index Scan on orders_new_created_idx  (cost=0.00..36.68 rows=1653 width=0) (actual time=0.168..0.168 rows=1709 loops=1)
               Index Cond: (created_at >= '2026-06-01 00:00:00+00'::timestamp with time zone)
               Buffers: shared read=7
 Planning:
   Buffers: shared hit=136
 Planning Time: 0.436 ms
 Execution Time: 1.604 ms
(15 rows)
```

The index is 128 kB, about a twentieth of a full index on `created_at`, since it holds only the
5% of rows with `status = 'new'`. Its Index Cond shows only the `created_at` range: the status
condition is part of the index definition, so there is nothing left to check for it inside the
index. The heap reads dominate, so the saving is smaller than for q1.

### q3

Case-insensitive lookup by `lower(name)` among live products (`deleted_at IS NULL`). Index: `products_lower_name_idx`. [`db/queries/q3.sql`](queries/q3.sql)

`products_lower_name_idx` entered the plan as a plain Index Scan, the Seq Scan on `products` disappeared, and buffers fell from 4,150 to 4: the walk down the B-tree plus the one heap page holding the row.

Before:

```
                                               QUERY PLAN                                                
---------------------------------------------------------------------------------------------------------
 Seq Scan on products  (cost=0.00..5650.00 rows=500 width=52) (actual time=0.052..36.422 rows=1 loops=1)
   Filter: ((deleted_at IS NULL) AND (lower(name) = 'легкі кросівки 80'::text))
   Rows Removed by Filter: 99999
   Buffers: shared hit=4150
 Planning:
   Buffers: shared hit=72
 Planning Time: 0.261 ms
 Execution Time: 36.460 ms
(8 rows)
```

After:

```
                                                            QUERY PLAN                                                             
-----------------------------------------------------------------------------------------------------------------------------------
 Index Scan using products_lower_name_idx on products  (cost=0.42..8.44 rows=1 width=52) (actual time=0.053..0.053 rows=1 loops=1)
   Index Cond: (lower(name) = 'легкі кросівки 80'::text)
   Buffers: shared hit=1 read=3
 Planning:
   Buffers: shared hit=135 read=1
 Planning Time: 0.574 ms
 Execution Time: 0.095 ms
(7 rows)
```

The row estimate went from 500 to 1. Before, Postgres had no statistics for `lower(name)` and used
its default guess of 0.5% of the table. `ANALYZE` after building the expression index collects
statistics on the expression, so the estimate became exact.

The index is partial (`WHERE deleted_at IS NULL`, the same condition as the query), and the
planner ignores statistics collected for a partial index's expression. With the index alone,
the estimate stayed at 500 and the plan became a Bitmap Heap Scan. `CREATE STATISTICS … ON
(lower(name))` collects the same statistics over the whole table, which brings the estimate back
to 1 and the plan back to an Index Scan. The `deleted_at` condition doesn't appear in the
after-plan: the index holds only live rows, so there is nothing left to check.

### q4

Full-text search for `шкіряні кросівки` among live products, top 20 by rank. Index: `products_search_vector_idx`. [`db/queries/q4.sql`](queries/q4.sql)

`products_search_vector_idx` entered the plan as a Bitmap Index Scan, the Seq Scan on `products` disappeared (the Limit and top-N Sort stayed), and buffers fell from 4,156 to 377: 14 in the GIN index, 357 for the heap pages holding the 357 matches, and 6 at the Sort node.

Before:

```
                                                      QUERY PLAN                                                       
-----------------------------------------------------------------------------------------------------------------------
 Limit  (cost=5410.54..5410.59 rows=20 width=49) (actual time=12.587..12.590 rows=20 loops=1)
   Buffers: shared hit=4156
   ->  Sort  (cost=5410.54..5411.44 rows=362 width=49) (actual time=12.586..12.587 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 27kB
         Buffers: shared hit=4156
         ->  Seq Scan on products  (cost=0.00..5400.90 rows=362 width=49) (actual time=0.046..12.472 rows=357 loops=1)
               Filter: ((deleted_at IS NULL) AND (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery))
               Rows Removed by Filter: 99643
               Buffers: shared hit=4150
 Planning:
   Buffers: shared hit=99
 Planning Time: 0.333 ms
 Execution Time: 12.623 ms
(14 rows)
```

After (warm):

```
                                                                     QUERY PLAN                                                                     
----------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=1114.69..1114.74 rows=20 width=49) (actual time=1.166..1.169 rows=20 loops=1)
   Buffers: shared hit=377
   ->  Sort  (cost=1114.69..1115.57 rows=354 width=49) (actual time=1.165..1.167 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 27kB
         Buffers: shared hit=377
         ->  Bitmap Heap Scan on products  (cost=31.91..1105.27 rows=354 width=49) (actual time=0.278..1.097 rows=357 loops=1)
               Recheck Cond: ((search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery) AND (deleted_at IS NULL))
               Heap Blocks: exact=357
               Buffers: shared hit=371
               ->  Bitmap Index Scan on products_search_vector_idx  (cost=0.00..31.82 rows=354 width=0) (actual time=0.245..0.245 rows=357 loops=1)
                     Index Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                     Buffers: shared hit=14
 Planning:
   Buffers: shared hit=169
 Planning Time: 0.496 ms
 Execution Time: 1.206 ms
(17 rows)
```

This is the warm run: a second execution, all 377 buffers already in cache. The first run after
building the index read the same 377 buffers in 1.274 ms; both are in `after.txt`. GIN always
produces a bitmap, never a plain index scan: it maps each word to a list of rows, and the AND of
two words is an intersection of two lists. `Recheck Cond` re-tests each row against the query.
The index is partial on `deleted_at IS NULL`, like q3's. A GIN bitmap is rechecked on the heap
anyway, so `deleted_at IS NULL` shows up in the Recheck Cond, but it costs no extra pages.

The seed deletes no products, so each partial index is the same size as a full one would be. Here
the partial predicate keeps discontinued products out of search results; it doesn't save space.

## Foreign key index

Postgres doesn't index a foreign key's referencing column. `order_items` has two foreign keys:
`order_id` is the left column of the primary key, so it's covered, but `product_id` had no index.
Deleting a product then has to scan all 200,000 lines to check that none still reference it.
The `Init` migration creates `order_items_product_id_idx` (4.5 MB) for this (in HW#12, `db/schema.sql` did).

Measured by deleting a newly inserted product that no order line references, inside a rolled-back
transaction:

| | `Trigger for constraint order_items_product_id_fkey` |
|---|---|
| Without the index | 7.290 ms |
| With the index | 0.272 ms |

## Морфологія

The search finds one grammatical form of a word and misses the others:

| Query form | Matches |
|---|---|
| `кросівки` (nominative plural) | 2,500 |
| `кросівок` (genitive plural) | 0 |
| `сумки` (nominative plural) | 25,000 |
| `сумок` (genitive plural) | 0 |

Measured with `search_vector @@ plainto_tsquery('simple', …)`. The seed only writes the
nominative forms, so every genitive search finds nothing, although the same products are
in the catalogue.

**Why:** the `simple` configuration doesn't stem. It lowercases the text and splits it into
words, nothing more, so `кросівки` and `кросівок` are stored as two unrelated lexemes. The
GIN index has no way of knowing they are the same word.

**There is no Ukrainian configuration to switch to.** `pg_ts_config` lists 29 configurations
shipped with Postgres, `simple` among them, and none for Ukrainian: Snowball, the stemmer
library Postgres uses, has no Ukrainian stemmer.

**Switching to `russian` is not a fix.** It applies Russian rules to Ukrainian text. Some
forms collapse by coincidence, others don't, and nothing reports the difference:

| Word | `simple` | `russian` |
|---|---|---|
| кросівки | `кросівки` | `кросівк` |
| кросівкам | `кросівкам` | `кросівк` |
| кросівок | `кросівок` | `кросівок` |
| сумка / сумки | `сумка` / `сумки` | `сумк` / `сумк` |
| сумок | `сумок` | `сумок` |
| шкіряна | `шкіряна` | `шкірян` |
| шкіряні | `шкіряні` | `шкіряні` |

`russian` joins кросівки with кросівкам, but still leaves кросівок on its own, so the
genitive search this section started with would still return 0. It also splits шкіряна from
шкіряні, because the Russian rules don't recognise the Ukrainian ending `-і`. The result is
wrong stemming instead of no stemming, and with no error or warning when it happens.
`simple` at least fails predictably: a search matches exactly the word form typed.
