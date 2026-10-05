import { DataSource, In, type DataSourceOptions } from 'typeorm';
import { QueryCountLogger } from './common/query-count-logger.js';
import { dataSource as cliDataSource } from './data-source.js';
import { OrderEntity, OrderItemEntity } from './entities/index.js';

// Loads the same graph — order → items → product, two levels of relations —
// with four strategies, at two collection sizes, and counts the SQL each sends.
// The fixes must stay constant while the naive version grows with the size.

const COLLECTION_SIZES = [10, 50];
// The SQL is printed at the first size only: enough to see the N+1 in the log.
// DEMO_FULL_SQL=1 prints whole statements with their parameters.
const ECHO_MODE = process.env.DEMO_FULL_SQL === '1' ? 'full' : 'short';

// A separate DataSource with the counting logger, so data-source.ts stays as
// the CLI uses it.
const queryLogger = new QueryCountLogger(['query']);
const demoDataSource = new DataSource({
  ...cliDataSource.options,
  logging: ['query'],
  logger: queryLogger,
} as DataSourceOptions);

const orderRepository = demoDataSource.getRepository(OrderEntity);
const orderItemRepository = demoDataSource.getRepository(OrderItemEntity);

interface LoadStrategy {
  name: string;
  load: (orderIds: string[]) => Promise<OrderEntity[]>;
}

const strategies: LoadStrategy[] = [
  {
    name: 'naive: query per order in a loop',
    load: async (orderIds) => {
      const orders = await orderRepository.find({ where: { id: In(orderIds) }, order: { id: 'ASC' } });
      for (const order of orders) {
        order.items = await orderItemRepository.find({
          where: { orderId: order.id },
          relations: { product: true },
        });
      }
      return orders;
    },
  },
  {
    name: 'fix: relations (LEFT JOIN)',
    load: (orderIds) =>
      orderRepository.find({
        where: { id: In(orderIds) },
        relations: { items: { product: true } },
      }),
  },
  {
    name: 'fix: leftJoinAndSelect',
    load: (orderIds) =>
      orderRepository
        .createQueryBuilder('orders')
        .leftJoinAndSelect('orders.items', 'items')
        .leftJoinAndSelect('items.product', 'product')
        .where('orders.id IN (:...orderIds)', { orderIds })
        .getMany(),
  },
  {
    name: "fix: relationLoadStrategy 'query'",
    load: (orderIds) =>
      orderRepository.find({
        where: { id: In(orderIds) },
        relations: { items: { product: true } },
        relationLoadStrategy: 'query',
      }),
  },
];

// Picked by id, not loaded with take: take together with relations makes
// TypeORM send a separate distinct-ids query first, which would inflate "after".
async function firstOrderIds(count: number): Promise<string[]> {
  const orders = await orderRepository.find({ select: { id: true }, order: { id: 'ASC' }, take: count });
  return orders.map((order) => order.id);
}

async function countQueries(strategy: LoadStrategy, orderIds: string[], echo: boolean): Promise<number> {
  if (echo) console.log(`\n── ${strategy.name} (n=${orderIds.length}) ──`);

  queryLogger.echo = echo ? ECHO_MODE : 'off';
  queryLogger.reset(); // initialize() and the id lookup aren't counted
  const orders = await strategy.load(orderIds);
  const queryCount = queryLogger.queryCount;
  queryLogger.echo = 'off';

  // Same data from every strategy — a fix that loads fewer rows isn't a fix.
  if (echo) {
    const lineCount = orders.reduce((sum, order) => sum + order.items.length, 0);
    console.log(`    → ${queryCount} queries, ${orders.length} orders, ${lineCount} lines`);
  }
  return queryCount;
}

await demoDataSource.initialize();
try {
  const queriesByStrategy: Record<string, Record<string, number>> = {};

  for (const size of COLLECTION_SIZES) {
    const orderIds = await firstOrderIds(size);
    const echo = size === COLLECTION_SIZES[0];

    for (const strategy of strategies) {
      (queriesByStrategy[strategy.name] ??= {})[`n=${size}`] = await countQueries(strategy, orderIds, echo);
    }
  }

  console.log('\nQueries per strategy (graph: order → items → product, 2 levels):');
  console.table(queriesByStrategy);
} finally {
  await demoDataSource.destroy();
}
