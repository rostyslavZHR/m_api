import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { checkoutWithKey } from '../checkout/checkout.js';
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
import type { AuthUser } from '../auth/tokens.js';

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

// No user_id: the order is placed for the caller (req.user), never for a user named in
// the body. The spec's additionalProperties: false answers 400 to a body that has one.
export interface CreateOrder {
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
  user: AuthUser;
}

export interface StreamEvents {
  orderId: number;
  afterId: number;
  user: AuthUser;
}

export interface FindOwnedOrder {
  orderId: number;
  userId: number;
}

export interface OwnedOrder {
  status: OrderStatus;
  lastEventId: number | null;
}

// sha256 of the canonical request body: fixed key order, items sorted by product,
// so the same order written differently (items in another order, extra spaces)
// gives the same fingerprint. Only detects misuse of a key (same key, different
// body); never used as the key, or two identical orders placed on purpose would
// merge into one.
const requestFingerprint = (userId: string, body: CreateOrder): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        user_id: userId,
        items: [...body.items]
          .sort((a, b) => a.product_id - b.product_id)
          .map(({ product_id, quantity }) => ({ product_id, quantity })),
      }),
    )
    .digest('hex');

// The owner, or an admin. 403, not 404: the brief's criterion. It does tell a caller
// that the id exists, which ids that only grow don't hide anyway.
const assertCanAccess = (order: OrderEntity, user: AuthUser): void => {
  if (order.userId !== user.id && user.role !== 'admin') {
    throw new ForbiddenException(`Order ${order.id} is not yours.`);
  }
};

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

  constructor(
    private readonly dataSource: DataSource,
    private readonly orders: OrdersRepository,
    private readonly ordersEventBus: OrderEventsBus,
  ) {}

  // The ownership level of authorization, for every route that takes an order id:
  // load by id, then compare. An unknown id → 404, someone else's order → 403. (A
  // WHERE id = $1 AND user_id = $2 can't tell the two apart: both find no row.)
  // An admin may read and change any order (support).
  async getById(id: number, user: AuthUser): Promise<Order> {
    return toOrder(await this.findAccessible(id, user));
  }

  // The caller's orders only, admins included: the list is "my orders".
  async list(
    user: AuthUser,
    limitParam: string | undefined,
    cursorParam: string | undefined,
  ) {
    const limit = limitParam !== undefined ? Number(limitParam) : 20;
    const afterId =
      cursorParam !== undefined ? this.decodeCursor(cursorParam) : undefined;

    // One extra row tells whether another page exists.
    const rows = await this.orders.list({
      userId: user.id,
      limit: limit + 1,
      afterId,
    });
    const page = rows.slice(0, limit);
    const next_cursor =
      rows.length > limit ? this.encodeCursor(page[page.length - 1].id) : null;

    return { items: page.map(toOrder), next_cursor };
  }

  // Idempotency-Key (level 3), stored in idempotency_keys and claimed inside the
  // checkout transaction (checkoutWithKey), so it survives a restart and is shared
  // by every instance. `replayed` tells the controller to add Idempotent-Replayed.
  async create(
    idempotencyKey: string,
    user: AuthUser,
    body: CreateOrder,
  ): Promise<{ order: Order; replayed: boolean }> {
    const productIds = body.items.map((item) => item.product_id);
    if (new Set(productIds).size !== productIds.length) {
      throw new BadRequestException(
        'Each product can appear only once in an order.',
      );
    }

    const fingerprint = requestFingerprint(user.id, body);
    let result: Awaited<ReturnType<typeof checkoutWithKey>>;
    try {
      result = await checkoutWithKey(
        this.dataSource,
        {
          userId: user.id,
          items: body.items.map((item) => ({
            productId: String(item.product_id),
            quantity: item.quantity,
          })),
        },
        { key: idempotencyKey, fingerprint },
      );
    } catch (error) {
      if (
        error instanceof OutOfStockError ||
        error instanceof InsufficientFundsError
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    if (result.replayed && result.fingerprint !== fingerprint) {
      throw new UnprocessableEntityException(
        'This Idempotency-Key was already used with a different request body.',
      );
    }
    // Read back, so the response is what the database holds. A replay returns the
    // same order as the first response; its status is the current one.
    const orderId = result.replayed ? result.orderId : result.order.id;
    return {
      order: toOrder(await this.findOrThrow(Number(orderId))),
      replayed: result.replayed,
    };
  }

  async updateStatus({ id, to, user }: UpdateStatus): Promise<Order> {
    // No retry wrapper: one row lock at READ COMMITTED can't hit 40001/40P01,
    // and a lost race is a 409 for the client to re-read, not something to retry.
    const orderEvent = await this.dataSource.transaction(async (manager) => {
      // Not this.orders: that one runs on the default manager, so each query takes any
      // pooled connection and commits on its own, outside this transaction. A repository
      // built on the callback's manager keeps every query on the transaction's connection.
      const orders = new OrdersRepository(manager);
      const order = await orders.findById(String(id));

      if (!order) throw new NotFoundException(`Order ${id} not found.`);
      assertCanAccess(order, user);
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
    return toOrder(await this.findOrThrow(id));
  }

  // One order's status events: history (rows already in order_events after afterId),
  // then live events from the bus. The 404 and 403 checks run before the stream
  // starts, so they still get a proper problem+json response.
  async streamEvents({
    orderId,
    afterId,
    user,
  }: StreamEvents): Promise<Observable<OrderStatusEvent>> {
    await this.findAccessible(orderId, user);

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

  private async findAccessible(id: number, user: AuthUser): Promise<OrderEntity> {
    const order = await this.findOrThrow(id);
    assertCanAccess(order, user);
    return order;
  }

  private async findOrThrow(id: number): Promise<OrderEntity> {
    const order = await this.orders.findById(String(id));
    if (!order) throw new NotFoundException(`Order ${id} not found.`);
    return order;
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
