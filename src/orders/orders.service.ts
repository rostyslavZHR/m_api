import { isDeepStrictEqual } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
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
import {
  OrderStatusEvent,
  toStatusEvent,
} from '../order-events/order-status-event.js';
import { Observable } from 'rxjs';

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

export interface StreamEvents {
  orderId: number;
  afterId: number;
}

export interface FindOwnedOrder {
  orderId: number;
  userId: number;
}

export interface OwnedOrder {
  status: OrderStatus;
  lastEventId: number | null;
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
  private readonly logger = new Logger(OrdersService.name);

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

  // One order's status events: history (rows already in order_events after afterId),
  // then live events from the bus. The 404 check runs before the stream starts, so an
  // unknown order still gets a proper problem+json response.
  async streamEvents({
    orderId,
    afterId,
  }: StreamEvents): Promise<Observable<OrderStatusEvent>> {
    const order = await this.orders.findById(String(orderId));
    if (!order) throw new NotFoundException(`Order ${orderId} not found.`);

    // Runs once per subscriber (per SSE connection), when Nest subscribes.
    return new Observable((subscriber) => {
      let lastSent = afterId;
      // Holds live events while history loads; null once history is sent.
      let buffer: OrderStatusEvent[] | null = [];

      // One gate for history, buffer and live: drops anything at or before what was
      // sent, so an event both in history and in the buffer goes out once.
      const send = (event: OrderStatusEvent) => {
        if (event.eventId <= lastSent) return;
        lastSent = event.eventId;
        subscriber.next(event);
      };

      // 1. Subscribe to live first: the other way round, an event committed during
      // the history read would be lost. Keep the callback trivial (push or send): a
      // throw inside a Subject subscriber is an uncaught exception that crashes Node.
      const live = this.ordersEventBus
        .forOrder(orderId)
        .subscribe((event) => (buffer ? buffer.push(event) : send(event)));

      // 2. History, then what was buffered meanwhile, then switch to live. Synchronous
      // inside .then, so no live event can slip in between.
      this.orders
        .findOrderEvents({ orderId: String(orderId), afterId: String(afterId) })
        .then((events) => {
          events.map(toStatusEvent).forEach(send);
          buffer!.forEach(send); // only this callback sets it to null, below
          buffer = null;
        })
        .catch((err) => {
          this.logger.error(err); // the details stay here; the controller ends the stream
          subscriber.error(err);
        });

      // 3. Teardown: Nest unsubscribes when the client disconnects; without this, every
      // closed connection would leave a listener on the bus.
      return () => live.unsubscribe();
    });
  }

  // null for an unknown order and for someone else's alike, so a client can't
  // probe which order ids exist.
  async findOwnedOrder({
    orderId,
    userId,
  }: FindOwnedOrder): Promise<OwnedOrder | null> {
    const row = await this.orders.findOwnedOrder({
      orderId: String(orderId),
      userId: String(userId),
    });
    if (!row) return null;
    return {
      status: row.status,
      lastEventId: row.lastEventId === null ? null : Number(row.lastEventId),
    };
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
