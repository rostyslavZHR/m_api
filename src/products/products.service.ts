import { Injectable, NotFoundException } from '@nestjs/common';

export interface Product {
  id: number;
  title: string;
  price_cents: number;
  in_stock: boolean;
}

const products: Product[] = [
  { id: 1, title: 'Mechanical Keyboard', price_cents: 8999, in_stock: true },
  { id: 2, title: 'Wireless Mouse', price_cents: 2499, in_stock: true },
  { id: 3, title: '27-inch Monitor', price_cents: 24999, in_stock: false },
  { id: 4, title: 'USB-C Dock', price_cents: 5999, in_stock: true },
];

@Injectable()
export class ProductsService {
  findAll(): Product[] {
    return products;
  }

  findById(id: number): Product {
    const product = this.find(id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found.`);
    }
    return product;
  }

  find(id: number): Product | undefined {
    return products.find((p) => p.id === id);
  }
}
