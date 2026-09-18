import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ProductsService } from '../products/products.service.js';

interface OrderItem {
  product_id: number;
  quantity: number;
}

export interface Order {
  id: number;
  items: OrderItem[];
  total_cents: number;
  status: 'new' | 'paid' | 'shipped';
  created_at: string;
}

interface Cursor {
  created_at: string;
  id: number;
}

const orders: Order[] = [
  {
    id: 1,
    items: [{ product_id: 1, quantity: 1 }],
    total_cents: 8999,
    status: 'new',
    created_at: '2026-09-15T09:00:00.000Z',
  },
  {
    id: 2,
    items: [{ product_id: 2, quantity: 2 }],
    total_cents: 4998,
    status: 'paid',
    created_at: '2026-09-15T09:01:00.000Z',
  },
  {
    id: 3,
    items: [
      { product_id: 3, quantity: 1 },
      { product_id: 4, quantity: 1 },
    ],
    total_cents: 30998,
    status: 'shipped',
    created_at: '2026-09-15T09:02:00.000Z',
  },
  {
    id: 4,
    items: [{ product_id: 4, quantity: 3 }],
    total_cents: 17997,
    status: 'new',
    created_at: '2026-09-15T09:03:00.000Z',
  },
  {
    id: 5,
    items: [{ product_id: 1, quantity: 2 }],
    total_cents: 17998,
    status: 'paid',
    created_at: '2026-09-15T09:04:00.000Z',
  },
];

@Injectable()
export class OrdersService {
  private readonly idempotencyKeys = new Map<string, { bodyKey: string; order: Order }>();

  constructor(private readonly productsService: ProductsService) {}

  findById(id: number): Order {
    const order = orders.find((o) => o.id === id);
    if (!order) {
      throw new NotFoundException(`Order ${id} not found.`);
    }
    return order;
  }

  list(limitParam: string | undefined, cursorParam: string | undefined): { items: Order[]; next_cursor: string | null } {
    const limit = limitParam !== undefined ? Number(limitParam) : 20;

    const sorted = [...orders].sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.id - b.id;
    });

    let startIndex = 0;
    if (cursorParam !== undefined) {
      const decoded = this.decodeCursor(cursorParam);
      startIndex = sorted.findIndex((order) => {
        if (order.created_at !== decoded.created_at) return order.created_at > decoded.created_at;
        return order.id > decoded.id;
      });
      if (startIndex === -1) startIndex = sorted.length;
    }

    const page = sorted.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + page.length < sorted.length;
    const next_cursor = hasMore ? this.encodeCursor(page[page.length - 1]) : null;

    return { items: page, next_cursor };
  }

  create(idempotencyKey: string, body: { items: OrderItem[] }): Order {
    const bodyKey = JSON.stringify(body);

    const existing = this.idempotencyKeys.get(idempotencyKey);
    if (existing) {
      if (existing.bodyKey !== bodyKey) {
        throw new UnprocessableEntityException('This Idempotency-Key was already used with a different request body.');
      }
      return existing.order;
    }

    let total_cents = 0;
    for (const item of body.items) {
      const product = this.productsService.find(item.product_id);
      if (!product) {
        throw new BadRequestException(`Product ${item.product_id} does not exist.`);
      }
      total_cents += product.price_cents * item.quantity;
    }

    const order: Order = {
      id: orders.length ? Math.max(...orders.map((o) => o.id)) + 1 : 1,
      items: body.items,
      total_cents,
      status: 'new',
      created_at: new Date().toISOString(),
    };

    orders.push(order);
    this.idempotencyKeys.set(idempotencyKey, { bodyKey, order });
    return order;
  }

  private encodeCursor(order: Order): string {
    return Buffer.from(JSON.stringify({ created_at: order.created_at, id: order.id })).toString('base64url');
  }

  private decodeCursor(cursor: string): Cursor {
    try {
      const json = Buffer.from(cursor, 'base64url').toString('utf8');
      const decoded = JSON.parse(json);
      if (typeof decoded !== 'object' || decoded === null || typeof decoded.created_at !== 'string' || typeof decoded.id !== 'number') {
        throw new Error('invalid cursor shape');
      }
      return decoded;
    } catch {
      throw new BadRequestException('The cursor query parameter is not a valid pagination token.');
    }
  }
}
