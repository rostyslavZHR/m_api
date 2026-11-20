import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { ProductEntity } from '../entities/index.js';
import { cacheAside, type Ttl } from '../redis/cache-aside.js';
import { REDIS_CACHE } from '../redis/redis.module.js';
import { type ProductCard, ProductsRepository } from './products.repository.js';

// v1: bump it when the card's shape changes, and every old entry is ignored at once.
export const cardKey = (id: number) => `product:card:${id}:v1`;
// 300–360 s.
export const CARD_TTL: Ttl = { baseSeconds: 300, jitterSeconds: 60 };

// The Product schema in openapi/openapi.yaml.
export interface Product {
  id: number;
  title: string;
  price_cents: number;
  in_stock: boolean;
}

// The CreateProduct schema in openapi/openapi.yaml: the body of POST /products.
export interface CreateProduct {
  title: string;
  description?: string;
  price_cents: number;
  stock?: number;
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
  constructor(
    private readonly products: ProductsRepository,
    @Inject(REDIS_CACHE) private readonly cache: Redis,
  ) {}

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

  // A new id, so no cached card can be stale for it.
  async create(body: CreateProduct): Promise<Product> {
    const entity = await this.products.insert({
      name: body.title,
      description: body.description ?? '',
      priceCents: String(body.price_cents),
      stock: body.stock ?? 0,
    });
    return toProduct(entity);
  }

  // Cache-aside around the card's aggregate query. hit tells the controller
  // which path served it (the X-Cache header).
  async getCard(id: number): Promise<{ card: ProductCard; hit: boolean }> {
    const { value, hit } = await cacheAside(this.cache, cardKey(id), CARD_TTL, () =>
      this.products.findCard(String(id)),
    );
    if (!value) {
      throw new NotFoundException(`Product ${id} not found.`);
    }
    return { card: value, hit };
  }
}
