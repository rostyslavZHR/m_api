import { Injectable, NotFoundException } from '@nestjs/common';
import type { ProductEntity } from '../entities/index.js';
import { ProductsRepository } from './products.repository.js';

// The Product schema in openapi/openapi.yaml.
export interface Product {
  id: number;
  title: string;
  price_cents: number;
  in_stock: boolean;
}

// bigint columns arrive as strings; these values are far below 2^53.
const toProduct = (entity: ProductEntity): Product => ({
  id: Number(entity.id),
  title: entity.name,
  price_cents: Number(entity.priceCents),
  in_stock: entity.stock > 0,
});

@Injectable()
export class ProductsService {
  constructor(private readonly products: ProductsRepository) {}

  async findAll(): Promise<Product[]> {
    return (await this.products.findAll()).map(toProduct);
  }

  async findById(id: number): Promise<Product | null> {
    const entity = await this.products.findById(String(id));
    return entity && toProduct(entity);
  }

  async getById(id: number): Promise<Product> {
    const product = await this.findById(id);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found.`);
    }
    return product;
  }
}
