import { ProductEntity } from '../../src/entities/index.js';
import { ProductsRepository } from '../../src/products/products.repository.js';
import { aProduct } from './testkit/builders.js';
import { startTestDatabase, type TestDatabase } from './testkit/postgres.js';

describe('ProductsRepository', () => {
  let db: TestDatabase;
  let products: ProductsRepository;

  const stockOf = async (id: string) =>
    (await db.app.manager.findOneOrFail(ProductEntity, { where: { id }, withDeleted: true })).stock;

  beforeAll(async () => {
    db = await startTestDatabase();
    products = new ProductsRepository(db.app.manager);
  });

  beforeEach(async () => {
    await db.reset();
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('inserts a product and reads it back', async () => {
    const created = await aProduct().withStock(3).insertVia(products);

    expect(await products.findById(created.id)).toMatchObject({
      id: created.id,
      name: created.name,
      priceCents: '1000',
      stock: 3,
      deletedAt: null,
    });
  });

  it('leaves soft-deleted products out of findAll and findById', async () => {
    const kept = await aProduct().insertVia(products);
    const discontinued = await aProduct().insertVia(products);
    await db.app.manager.softDelete(ProductEntity, discontinued.id);

    expect((await products.findAll()).map((product) => product.id)).toEqual([kept.id]);
    expect(await products.findById(discontinued.id)).toBeNull();
  });

  it('reserveStock takes the stock and returns the price in force', async () => {
    const product = await aProduct().withStock(3).withPriceCents('2500').insertVia(products);

    expect(await products.reserveStock(product.id, 2)).toEqual({ name: product.name, priceCents: '2500' });
    expect(await stockOf(product.id)).toBe(1);
  });

  it('reserveStock refuses more than is in stock: zero rows, stock unchanged', async () => {
    const product = await aProduct().withStock(1).insertVia(products);

    expect(await products.reserveStock(product.id, 2)).toBeNull();
    expect(await stockOf(product.id)).toBe(1);
  });

  it('reserveStock refuses a soft-deleted product even with stock left', async () => {
    const product = await aProduct().withStock(5).insertVia(products);
    await db.app.manager.softDelete(ProductEntity, product.id);

    expect(await products.reserveStock(product.id, 1)).toBeNull();
    expect(await stockOf(product.id)).toBe(5);
  });

  it('negative stock violates CHECK (stock >= 0): 23514, whatever the code does', async () => {
    const product = await aProduct().withStock(1).insertVia(products);

    await expect(db.app.manager.update(ProductEntity, product.id, { stock: -1 })).rejects.toMatchObject({
      driverError: { code: '23514', constraint: 'products_stock_check' },
    });
  });
});
