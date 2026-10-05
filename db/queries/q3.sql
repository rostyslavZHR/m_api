/*
  q3 · case-insensitive product lookup by name.
  Index target: expression index on lower(name).
  A plain index on name cannot serve this query, because it stores name as
  written and the condition is on lower(name). The index must be built on
  the same expression the query uses. ANALYZE then also collects statistics
  on lower(name), fixing the planner's default guess of 0.5% of the table.
  Works on Cyrillic because the database LC_CTYPE is en_US.utf8. Under the
  C locale, lower() leaves Cyrillic untouched and only lowercases Latin.
  deleted_at IS NULL hides discontinued products and matches the index's
  WHERE, so the planner can use the partial index.
*/
SELECT id, name, price_cents, in_stock
FROM products
WHERE lower(name) = 'легкі кросівки 80'
  AND deleted_at IS NULL
