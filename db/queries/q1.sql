/*
  q1 · one user's orders within a date range, newest first.
  Index target: composite (user_id, created_at).
  Equality column first, range column second: the index jumps to user 42,
  then reads that user's date range as one contiguous slice. Reversed,
  (created_at, user_id) would scan the whole date range and filter user_id
  row by row. The index could also return rows already in date order, but
  the planner prefers a bitmap scan plus an in-memory sort of the ~25 rows,
  since they sit on as many scattered pages.
*/
SELECT id, status, total_cents, created_at
FROM orders
WHERE user_id = 42
  AND created_at >= '2026-03-01'
  AND created_at < '2026-06-01'
ORDER BY created_at DESC
