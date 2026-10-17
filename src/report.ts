import { dataSource } from './data-source.js';
import { revenueByProduct } from './reports/revenue-by-product.js';

// Prints revenue per product — an aggregate with JOIN and GROUP BY.
// What it shows: a result that isn't an entity, so it's a query builder with
// getRawMany(), not find(); soft-deleted products still count.
//
// What makes it hold, by KB question (dev-notes, postgres.md):
//   #90 — repository while the result is an entity, query builder once it isn't;
//         aggregates arrive as strings; .withDeleted() must come before the joins,
//         or the joined products stay filtered. The query: reports/revenue-by-product.ts.

await dataSource.initialize();
try {
  const rows = await revenueByProduct(dataSource);

  console.log('Revenue per product (non-cancelled orders):');
  console.table(rows);
} finally {
  await dataSource.destroy();
}
