import { isDeepStrictEqual } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { checkout } from '../checkout/checkout.js';
import {
  InsufficientFundsError,
  OutOfStockError,
} from '../checkout/checkout.errors.js';
import type { OrderEntity, OrderStatus } from '../entities/index.js';
import { OrdersRepository } from './orders.repository.js';
import { ORDER_TRANSITIONS } from '../entities/order.entity.js';
import { OrderEventsBus } from '../order-events/order-events.bus.js';
import { toStatusEvent } from '../order-events/order-status-event.js';

// The OrderItem, Order and CreateOrder schemas in openapi/openapi.yaml.
interface OrderItem {
  product_id: number;
  quantity: number;
}

export interface Order {
  id: number;
  items: OrderItem[];
  total_cents: number;
  status: OrderStatus;
  created_at: string;
}

export interface CreateOrder {
  user_id: number;
  items: OrderItem[];
}

// The UpdateOrderStatus schema in openapi/openapi.yaml: the request body of
// PATCH /orders/{id}/status. The id comes from the URL.
export interface UpdateOrderStatus {
  status: OrderStatus;
}

export interface UpdateStatus {
  id: number;
  to: OrderStatus;
}

// bigint columns arrive as strings; these values are far below 2^53.
const toOrder = (entity: OrderEntity): Order => ({
  id: Number(entity.id),
  items: entity.items.map((item) => ({
    product_id: Number(item.productId),
    quantity: item.quantity,
  })),
  total_cents: Number(entity.totalCents),
  status: entity.status,
  created_at: entity.createdAt.toISOString(),
});

@Injectable()
export class OrdersService {
  // Replays for Idempotency-Key. In memory, so per process and lost on restart;
  // a table with a unique key is the durable version.
  private readonly idempotencyKeys = new Map<
    string,
    { body: CreateOrder; order: Order }
  >();

  constructor(
    private readonly dataSource: DataSource,
    private readonly orders: OrdersRepository,
    private readonly ordersEventBus: OrderEventsBus,
  ) {}

  async getById(id: number): Promise<Order> {
    const order = await this.orders.findById(String(id));
    if (!order) {
      throw new NotFoundException(`Order ${id} not found.`);
    }
    return toOrder(order);
  }

  async list(limitParam: string | undefined, cursorParam: string | undefined) {
    const limit = limitParam !== undefined ? Number(limitParam) : 20;
    const afterId =
      cursorParam !== undefined ? this.decodeCursor(cursorParam) : undefined;

    // One extra row tells whether another page exists.
    const rows = await this.orders.list(limit + 1, afterId);
    const page = rows.slice(0, limit);
    const next_cursor =
      rows.length > limit ? this.encodeCursor(page[page.length - 1].id) : null;

    return { items: page.map(toOrder), next_cursor };
  }

  async create(idempotencyKey: string, body: CreateOrder): Promise<Order> {
    const replay = this.idempotencyKeys.get(idempotencyKey);
    if (replay) {
      if (!isDeepStrictEqual(replay.body, body)) {
        throw new UnprocessableEntityException(
          'This Idempotency-Key was already used with a different request body.',
        );
      }
      return replay.order;
    }

    const productIds = body.items.map((item) => item.product_id);
    if (new Set(productIds).size !== productIds.length) {
      throw new BadRequestException(
        'Each product can appear only once in an order.',
      );
    }

    let created: OrderEntity;
    try {
      created = await checkout(this.dataSource, {
        userId: String(body.user_id),
        items: body.items.map((item) => ({
          productId: String(item.product_id),
          quantity: item.quantity,
        })),
      });
    } catch (error) {
      if (
        error instanceof OutOfStockError ||
        error instanceof InsufficientFundsError
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    // Read back, so the response is what the database holds.
    const order = await this.getById(Number(created.id));
    this.idempotencyKeys.set(idempotencyKey, { body, order });
    return order;
  }

  async updateStatus({ id, to }: UpdateStatus): Promise<Order> {
    // No retry wrapper: one row lock at READ COMMITTED can't hit 40001/40P01,
    // and a lost race is a 409 for the client to re-read, not something to retry.
    const orderEvent = await this.dataSource.transaction(async (manager) => {
      // Not this.orders: that one runs on the default manager, so each query takes any
      // pooled connection and commits on its own, outside this transaction. A repository
      // built on the callback's manager keeps every query on the transaction's connection.
      const orders = new OrdersRepository(manager);
      const order = await orders.findById(String(id));

      if (!order) throw new NotFoundException(`Order ${id} not found.`);
      if (!ORDER_TRANSITIONS[order.status].includes(to)) {
        throw new ConflictException(
          `Order ${id} can't go from ${order.status} to ${to}.`,
        );
      }

      const updated = await orders.updateStatus({
        orderId: order.id,
        from: order.status,
        to,
      });

      if (!updated) {
        throw new ConflictException(
          `Order ${id} changed concurrently; read it and retry.`,
        );
      }
      return orders.insertEvent({ orderId: order.id, from: order.status, to });
    });

    this.ordersEventBus.publish(toStatusEvent(orderEvent));
    return this.getById(id);
  }

  private encodeCursor(id: string): string {
    return Buffer.from(JSON.stringify({ id })).toString('base64url');
  }

  private decodeCursor(cursor: string): string {
    try {
      const decoded: unknown = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );
      const id = (decoded as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !/^\d+$/.test(id)) {
        throw new Error('invalid cursor shape');
      }
      return id;
    } catch {
      throw new BadRequestException(
        'The cursor query parameter is not a valid pagination token.',
      );
    }
  }
}
