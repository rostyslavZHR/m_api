/*
  q2 · orders with the rare status 'new' (5% of rows) since a given date.
  Index target: partial index on (created_at) WHERE status = 'new'.
  It holds only the 5% of orders the query can ever match, so it is about
  a twentieth the size of a full index. The planner uses it only when the
  query repeats the index's WHERE condition, here status = 'new'.
*/
SELECT id, user_id, total, created_at
FROM orders
WHERE status = 'new'
  AND created_at >= '2026-06-01'
ORDER BY created_at DESC
