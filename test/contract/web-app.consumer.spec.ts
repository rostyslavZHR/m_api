import pact from '@pact-foundation/pact';
import { CONSUMER, PACT_DIR, PROVIDER } from './pact.js';
import { ProductNotFoundError, ProductsClient } from './products.client.js';

// @pact-foundation/pact is CommonJS: under ESM only its default export is reliable.
const { MatchersV3, PactV3 } = pact;
const { integer, like, regex } = MatchersV3;

const jsonContentType = (type: string) => regex(`^${type.replace('+', '\\+')}(;.*)?$`, `${type}; charset=utf-8`);

describe(`${CONSUMER} → ${PROVIDER}: products`, () => {
  const provider = new PactV3({ consumer: CONSUMER, provider: PROVIDER, dir: PACT_DIR });

  it('shows a product page for a product that exists', async () => {
    provider
      .given('product 42 exists')
      .uponReceiving('a request for product 42')
      .withRequest({ method: 'GET', path: '/products/42', headers: { Accept: 'application/json' } })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': jsonContentType('application/json') },
        // Only what the product page reads, with matchers instead of exact values.
        body: {
          id: integer(42),
          title: like('Mechanical Keyboard'),
          price_cents: integer(8999),
          in_stock: like(true),
        },
      });

    await provider.executeTest(async (mockServer) => {
      const product = await new ProductsClient(mockServer.url).getProduct(42);

      expect(product).toEqual({ id: 42, title: 'Mechanical Keyboard', priceCents: 8999, inStock: true });
    });
  });

  it('shows "not found" for a product that does not exist', async () => {
    provider
      .given('product 999 does not exist')
      .uponReceiving('a request for product 999')
      .withRequest({ method: 'GET', path: '/products/999', headers: { Accept: 'application/json' } })
      .willRespondWith({
        status: 404,
        headers: { 'Content-Type': jsonContentType('application/problem+json') },
        body: { status: integer(404), title: like('Not Found') },
      });

    await provider.executeTest(async (mockServer) => {
      await expect(new ProductsClient(mockServer.url).getProduct(999)).rejects.toBeInstanceOf(ProductNotFoundError);
    });
  });
});
