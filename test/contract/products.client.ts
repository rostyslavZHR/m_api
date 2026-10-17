// The imaginary web-app's API client: what its product page would call. The
// consumer test drives this, not raw fetch, so the contract describes what the
// frontend's own code sends and reads.

export interface Product {
  id: number;
  title: string;
  priceCents: number;
  inStock: boolean;
}

export class ProductNotFoundError extends Error {
  constructor(readonly productId: number) {
    super(`Product ${productId} not found`);
    this.name = 'ProductNotFoundError';
  }
}

interface ProductResponse {
  id: number;
  title: string;
  price_cents: number;
  in_stock: boolean;
}

export class ProductsClient {
  constructor(private readonly baseUrl: string) {}

  async getProduct(id: number): Promise<Product> {
    const response = await fetch(`${this.baseUrl}/products/${id}`, { headers: { Accept: 'application/json' } });

    if (response.status === 404) throw new ProductNotFoundError(id);
    if (!response.ok) throw new Error(`GET /products/${id} failed with ${response.status}`);

    const body = (await response.json()) as ProductResponse;
    return { id: body.id, title: body.title, priceCents: body.price_cents, inStock: body.in_stock };
  }
}
