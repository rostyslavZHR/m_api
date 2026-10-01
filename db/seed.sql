-- Resets all four tables and their id counters, so the file can be re-run
-- and C3/C4 can rely on user ids 1–1000 and product ids 1–100000.
TRUNCATE users, products, orders, order_items RESTART IDENTITY;

-- C1 · users
INSERT INTO users (email)
SELECT 'user' || i || '@example.com'
FROM generate_series(1, 1000) AS i;

SELECT count(*) FROM users; -- 1000

-- C2 · products
-- 'кросівки' is the rare noun (every 40th row, 2.5%) — the q4 search target.
-- It must not appear in the common-noun list, or its share stops being 2.5%.
INSERT INTO products (name, description, price, in_stock)
SELECT
    adj || ' ' || noun || ' ' || i,
    descr || ' ' || noun || ' для щоденного використання',
    (1000 + (i * 7919) % 499000) / 100.0, -- 10.00–4999.99 грн, same every run
    i % 11 <> 0 -- ~91% in stock; 11 is coprime with 40, so кросівки get the same ratio
FROM generate_series(1, 100000) AS i
CROSS JOIN LATERAL (
    SELECT
        (ARRAY['Шкіряні', 'Спортивні', 'Зимові', 'Легкі', 'Класичні', 'Водонепроникні', 'Стильні'])[1 + i % 7] AS adj,
        (ARRAY['Якісні', 'Надійні', 'Зручні'])[1 + i % 3] AS descr,
        CASE
            WHEN i % 40 = 0 THEN 'кросівки'
            ELSE (ARRAY['черевики', 'сумки', 'ноутбуки', 'куртки'])[1 + i % 4]
        END AS noun
) AS v;

SELECT count(*) FROM products; -- 100000

SELECT count(*) FILTER (WHERE search_vector @@ plainto_tsquery('simple', 'кросівки')) * 100.0 / count(*) AS match_pct
FROM products; -- 2.5

-- C3 · orders
-- user_id is random: 1 + i % 1000 would tie each user to one status,
-- since 1000 is a multiple of 20 (every order of user 20 would be 'new').
-- created_at is spread over the last year for q1's date-range filter.
-- total is 0 here; C5 computes it from the lines.
-- 'cancelled' is allowed by the schema's CHECK but deliberately not seeded.
INSERT INTO orders (user_id, status, total, created_at)
SELECT
    1 + floor(random() * 1000)::int,
    CASE
        WHEN i % 20 = 0 THEN 'new' -- 5% ← partial index target
        WHEN i % 4 = 0 THEN 'shipped' -- 20% (every 4th, minus the 5% already 'new')
        ELSE 'paid' -- 75%
    END,
    0,
    now() - random() * interval '365 days'
FROM generate_series(1, 100000) AS i;

SELECT status, count(*) FROM orders GROUP BY status ORDER BY count(*) DESC;

-- C4 · order_items
-- 1–3 lines per order (n ≤ 1 + id % 3). Each line's product is picked by
-- arithmetic on (order id, n): different n always gives a different product,
-- so the (order_id, product_id) primary key never collides.
INSERT INTO order_items (order_id, product_id, quantity, unit_price, product_name)
SELECT
    o.id,
    p.id,
    1 + floor(random() * 3)::int, -- 1–3
    p.price, -- snapshot
    p.name -- snapshot
FROM orders o
CROSS JOIN generate_series(1, 3) AS n
JOIN products p ON p.id = 1 + (o.id * 7 + n * 33333) % 100000
WHERE n <= 1 + o.id % 3;

SELECT count(*) FROM order_items; -- ~200000

-- C5 · order totals
-- The total is stored on the order (decision 9), so it's filled in once the lines exist.
UPDATE orders o SET total = (
    SELECT coalesce(sum(oi.quantity * oi.unit_price), 0)
    FROM order_items oi
    WHERE oi.order_id = o.id
);

SELECT count(*) FROM orders WHERE total = 0; -- 0

-- C6 · products size: how much of it is the tsvector column
SELECT pg_size_pretty(pg_total_relation_size('products')) AS total,
       pg_size_pretty(pg_relation_size('products')) AS heap,
       pg_size_pretty(pg_indexes_size('products')) AS indexes,
       pg_size_pretty(sum(pg_column_size(search_vector))) AS tsvector_data
FROM products;

-- C7 · clear the dead rows C5 left behind and refresh planner statistics.
-- VACUUM can't run inside a transaction: run this file with plain psql, not psql -1.
VACUUM (ANALYZE);
