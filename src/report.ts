import { dataSource } from './data-source.js';
import { revenueByProduct } from './reports/revenue-by-product.js';

await dataSource.initialize();
try {
  const rows = await revenueByProduct(dataSource);

  console.log('Revenue per product (non-cancelled orders):');
  console.table(rows);
} finally {
  await dataSource.destroy();
}
