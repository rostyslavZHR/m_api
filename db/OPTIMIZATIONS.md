# Optimizations — Marketplace API

## Baseline: dataset and storage

Seeded by `db/seed.sql`: 1,000 users, 100,000 products, 100,000 orders,
200,000 order lines. No indexes beyond primary keys.

`products` after seeding and `VACUUM (ANALYZE)`:

| Measure | Size |
|---|---|
| Total (`pg_total_relation_size`) | 35 MB |
| Heap (`pg_relation_size`) | 33 MB |
| Indexes (`pg_indexes_size`, primary key only) | 2.2 MB |
| `search_vector` data (`sum(pg_column_size(search_vector))`) | 15 MB — ~45% of the heap |

The stored `tsvector` column nearly doubles the table's footprint. That is the
cost of `GENERATED ... STORED`: the vector is kept on every row rather than
computed at query time. The GIN index built on it later adds to this.

## Before and after indexes

Clean rebuild: `docker compose down -v`, `db/schema.sql`, `db/seed.sql`, plans captured, then
`db/indexes.sql` (which ends with `ANALYZE`), plans captured again. Raw output is kept in
[`before.txt`](before.txt) and [`after.txt`](after.txt). q4's after-plan is the warm second run.

```sh
for q in 1 2 3 4; do
  psql -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q$q.sql)"
done
```

| Query | Buffers | Execution time | Plan after | Index size |
|---|---|---|---|---|
| q1 | 1,670 → 36 | 5.990 → 0.175 ms | Bitmap scan on `orders_user_created_idx` | 3.0 MB |
| q2 | 1,670 → 757 | 6.342 → 1.635 ms | Bitmap scan on `orders_new_created_idx` | 128 kB |
| q3 | 4,167 → 4 | 39.911 → 0.064 ms | Index Scan on `products_lower_name_idx` | 5.7 MB |
| q4 | 4,173 → 377 | 12.649 → 1.301 ms | Bitmap scan on `products_search_vector_idx` | 6.2 MB |

Buffers are the stable comparison; timings are single runs and vary by a few ms between runs.
The four indexes add 15.2 MB in total. Their cost on writes is not measured here.

### q1

One user's orders in a date range, newest first. Index: `orders_user_created_idx`. [`db/queries/q1.sql`](queries/q1.sql)

`orders_user_created_idx` entered the plan as a Bitmap Index Scan, the Seq Scan on `orders` disappeared (the Sort stayed), and buffers fell from 1,670 to 36: 6 in the index, 27 for the heap pages holding the 27 matching rows, and 3 at the Sort node.

Before:

```
                                                                                  QUERY PLAN                                                                                   
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=3417.58..3417.64 rows=25 width=29) (actual time=5.962..5.964 rows=27 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 26kB
   Buffers: shared hit=1670
   ->  Seq Scan on orders  (cost=0.00..3417.00 rows=25 width=29) (actual time=1.264..5.927 rows=27 loops=1)
         Filter: ((created_at >= '2026-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-06-01 00:00:00+00'::timestamp with time zone) AND (user_id = 42))
         Rows Removed by Filter: 99973
         Buffers: shared hit=1667
 Planning:
   Buffers: shared hit=100
 Planning Time: 0.307 ms
 Execution Time: 5.990 ms
(12 rows)
```

After:

```
                                                                                       QUERY PLAN                                                                                        
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=96.57..96.63 rows=25 width=29) (actual time=0.137..0.139 rows=27 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 26kB
   Buffers: shared hit=33 read=3
   ->  Bitmap Heap Scan on orders  (cost=4.74..95.99 rows=25 width=29) (actual time=0.046..0.112 rows=27 loops=1)
         Recheck Cond: ((user_id = 42) AND (created_at >= '2026-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-06-01 00:00:00+00'::timestamp with time zone))
         Heap Blocks: exact=27
         Buffers: shared hit=30 read=3
         ->  Bitmap Index Scan on orders_user_created_idx  (cost=0.00..4.73 rows=25 width=0) (actual time=0.035..0.035 rows=27 loops=1)
               Index Cond: ((user_id = 42) AND (created_at >= '2026-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-06-01 00:00:00+00'::timestamp with time zone))
               Buffers: shared hit=3 read=3
 Planning:
   Buffers: shared hit=143 read=2
 Planning Time: 0.545 ms
 Execution Time: 0.175 ms
(15 rows)
```

The Sort stayed because Postgres chose a bitmap scan and sorted the 27 rows in memory, rather
than walking the index backwards in `created_at` order. `created_at` has almost no correlation
with physical row order (0.00 in `pg_stats`), so the 27 rows sit on 27 different pages, and a
bitmap scan reads them in physical order. Sorting 27 rows costs next to nothing.

### q2

Orders with status `'new'` since a date. Index: `orders_new_created_idx`. [`db/queries/q2.sql`](queries/q2.sql)

`orders_new_created_idx` entered the plan as a Bitmap Index Scan, the Seq Scan on `orders` disappeared (the Sort stayed), and buffers fell from 1,670 to 757: 6 in the index, 748 in the heap because the 1,608 matching orders are spread over 748 pages, and 3 at the Sort node.

Before:

```
                                                   QUERY PLAN                                                    
-----------------------------------------------------------------------------------------------------------------
 Sort  (cost=3254.57..3258.67 rows=1640 width=32) (actual time=6.161..6.243 rows=1608 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 136kB
   Buffers: shared hit=1670
   ->  Seq Scan on orders  (cost=0.00..3167.00 rows=1640 width=32) (actual time=0.450..5.843 rows=1608 loops=1)
         Filter: ((created_at >= '2026-06-01 00:00:00+00'::timestamp with time zone) AND (status = 'new'::text))
         Rows Removed by Filter: 98392
         Buffers: shared hit=1667
 Planning:
   Buffers: shared hit=100
 Planning Time: 0.320 ms
 Execution Time: 6.342 ms
(12 rows)
```

After:

```
                                                                 QUERY PLAN                                                                 
--------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=1859.24..1863.24 rows=1602 width=32) (actual time=1.433..1.520 rows=1608 loops=1)
   Sort Key: created_at DESC
   Sort Method: quicksort  Memory: 136kB
   Buffers: shared hit=751 read=6
   ->  Bitmap Heap Scan on orders  (cost=36.70..1773.97 rows=1602 width=32) (actual time=0.247..1.114 rows=1608 loops=1)
         Recheck Cond: ((created_at >= '2026-06-01 00:00:00+00'::timestamp with time zone) AND (status = 'new'::text))
         Heap Blocks: exact=748
         Buffers: shared hit=748 read=6
         ->  Bitmap Index Scan on orders_new_created_idx  (cost=0.00..36.30 rows=1602 width=0) (actual time=0.160..0.160 rows=1608 loops=1)
               Index Cond: (created_at >= '2026-06-01 00:00:00+00'::timestamp with time zone)
               Buffers: shared read=6
 Planning:
   Buffers: shared hit=136
 Planning Time: 0.486 ms
 Execution Time: 1.635 ms
(15 rows)
```

The index is 128 kB, about a twentieth of a full index on `created_at`, since it holds only the
5% of rows with `status = 'new'`. Its Index Cond shows only the `created_at` range: the status
condition is part of the index definition, so there is nothing left to check for it inside the
index. The heap reads dominate, so the saving is smaller than for q1.

### q3

Case-insensitive product lookup by `lower(name)`. Index: `products_lower_name_idx`. [`db/queries/q3.sql`](queries/q3.sql)

`products_lower_name_idx` entered the plan as a plain Index Scan, the Seq Scan on `products` disappeared, and buffers fell from 4,167 to 4: the walk down the B-tree plus the one heap page holding the row.

Before:

```
                                               QUERY PLAN                                                
---------------------------------------------------------------------------------------------------------
 Seq Scan on products  (cost=0.00..5667.00 rows=500 width=54) (actual time=0.066..39.878 rows=1 loops=1)
   Filter: (lower(name) = 'легкі кросівки 80'::text)
   Rows Removed by Filter: 99999
   Buffers: shared hit=4167
 Planning:
   Buffers: shared hit=69
 Planning Time: 0.273 ms
 Execution Time: 39.911 ms
(8 rows)
```

After:

```
                                                            QUERY PLAN                                                             
-----------------------------------------------------------------------------------------------------------------------------------
 Index Scan using products_lower_name_idx on products  (cost=0.42..8.44 rows=1 width=54) (actual time=0.030..0.030 rows=1 loops=1)
   Index Cond: (lower(name) = 'легкі кросівки 80'::text)
   Buffers: shared hit=1 read=3
 Planning:
   Buffers: shared hit=119 read=1
 Planning Time: 0.508 ms
 Execution Time: 0.064 ms
(7 rows)
```

The row estimate went from 500 to 1. Before, Postgres had no statistics for `lower(name)` and used
its default guess of 0.5% of the table. `ANALYZE` after building the expression index collects
statistics on the expression, so the estimate became exact.

### q4

Full-text search for `шкіряні кросівки`, top 20 by rank. Index: `products_search_vector_idx`. [`db/queries/q4.sql`](queries/q4.sql)

`products_search_vector_idx` entered the plan as a Bitmap Index Scan, the Seq Scan on `products` disappeared (the Limit and top-N Sort stayed), and buffers fell from 4,173 to 377: 14 in the GIN index, 357 for the heap pages holding the 357 matches, and 6 at the Sort node.

Before:

```
                                                      QUERY PLAN                                                       
-----------------------------------------------------------------------------------------------------------------------
 Limit  (cost=5427.48..5427.53 rows=20 width=49) (actual time=12.607..12.611 rows=20 loops=1)
   Buffers: shared hit=4173
   ->  Sort  (cost=5427.48..5428.38 rows=360 width=49) (actual time=12.606..12.608 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 27kB
         Buffers: shared hit=4173
         ->  Seq Scan on products  (cost=0.00..5417.90 rows=360 width=49) (actual time=0.054..12.529 rows=357 loops=1)
               Filter: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Rows Removed by Filter: 99643
               Buffers: shared hit=4167
 Planning:
   Buffers: shared hit=96
 Planning Time: 0.353 ms
 Execution Time: 12.649 ms
(14 rows)
```

After (warm):

```
                                                                     QUERY PLAN                                                                     
----------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=1140.10..1140.15 rows=20 width=49) (actual time=1.248..1.251 rows=20 loops=1)
   Buffers: shared hit=377
   ->  Sort  (cost=1140.10..1141.01 rows=364 width=49) (actual time=1.247..1.248 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 27kB
         Buffers: shared hit=377
         ->  Bitmap Heap Scan on products  (cost=31.96..1130.42 rows=364 width=49) (actual time=0.337..1.168 rows=357 loops=1)
               Recheck Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Heap Blocks: exact=357
               Buffers: shared hit=371
               ->  Bitmap Index Scan on products_search_vector_idx  (cost=0.00..31.87 rows=364 width=0) (actual time=0.304..0.304 rows=357 loops=1)
                     Index Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                     Buffers: shared hit=14
 Planning:
   Buffers: shared hit=153
 Planning Time: 0.521 ms
 Execution Time: 1.301 ms
(17 rows)
```

This is the warm run: a second execution, all 377 buffers already in cache. The first run after
building the index read the same 377 buffers in 1.643 ms; both are in `after.txt`. GIN always
produces a bitmap, never a plain index scan: it maps each word to a list of rows, and the AND of
two words is an intersection of two lists. `Recheck Cond` re-tests each row against the query.

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
