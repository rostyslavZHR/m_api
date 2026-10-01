-- Phase E indexes, one per query in db/queries/. Safe to re-run.

-- q1 · one user's orders in a date range, newest first.
-- Equality column first, range column second (→ #81): the index jumps to the
-- user, then reads their date range as one contiguous slice.
CREATE INDEX IF NOT EXISTS orders_user_created_idx
    ON orders (user_id, created_at);

-- q2 · rare status 'new' (5% of orders) since a date.
-- Partial: holds only the rows q2 can match. The planner uses it only when the
-- query's WHERE implies the predicate, which q2's status = 'new' does exactly.
CREATE INDEX IF NOT EXISTS orders_new_created_idx
    ON orders (created_at)
    WHERE status = 'new';

-- q3 · case-insensitive name lookup.
-- Expression index: stores lower(name), the value the query compares (→ #82 case 2).
CREATE INDEX IF NOT EXISTS products_lower_name_idx
    ON products (lower(name));

-- q4 · full-text search.
-- GIN maps each word to the rows that contain it, which is what @@ needs.
CREATE INDEX IF NOT EXISTS products_search_vector_idx
    ON products USING gin (search_vector);

-- An expression index has no statistics until ANALYZE runs: without this,
-- q3 keeps the planner's default guess of 500 rows.
ANALYZE orders, products;
