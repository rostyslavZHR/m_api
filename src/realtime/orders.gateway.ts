import { Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import type { OrderStatus } from '../entities/index.js';
import { OrderEventsBus } from '../order-events/order-events.bus.js';
import { OrdersService, type OwnedOrder } from '../orders/orders.service.js';

const room = (orderId: number) => `orders:${orderId}`;

// Handshake `auth`: a trusted claim until real auth.
const Handshake = z.object({ userId: z.number().int().positive() });

// The validator doesn't cover WebSocket messages, so payloads are checked here.
const JoinPayload = z.strictObject({ orderId: z.number().int().positive() });

// What join's ack carries. A plain value, never a throw: a throw doesn't ack.
export type JoinAck =
  | {
      ok: true;
      orderId: number;
      status: OrderStatus;
      lastEventId: number | null;
    }
  | { ok: false; error: 'invalid_payload' | 'not_found' | 'unavailable' };

// CORS left at Socket.IO's default (closed): the demo client is headless. A browser
// client on another origin would need `cors: { origin: [...] }` here.
@WebSocketGateway({ namespace: '/orders' })
export class OrdersGateway implements OnGatewayInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersGateway.name);
  private busSubscription?: Subscription;

  // The /orders namespace, set by Nest after init (hence `!`).
  @WebSocketServer() private readonly server!: Namespace;

  constructor(
    private readonly bus: OrderEventsBus,
    private readonly ordersService: OrdersService,
  ) {}

  // Runs once, before any client connects.
  afterInit(server: Namespace): void {
    // Checked before the connection exists: a bad handshake gets connect_error.
    // Identity lives in socket.data from here on, never in message bodies.
    server.use((socket, next) => {
      const parsed = Handshake.safeParse(socket.handshake.auth);
      if (!parsed.success) return next(new Error('unauthorized'));
      socket.data.userId = parsed.data.userId;
      next();
    });

    // One bus subscription for the gateway's lifetime. Per connection, each event
    // would reach a room once per connected socket. Keep the callback trivial: a
    // throw inside a Subject subscriber is an uncaught exception that crashes Node.
    this.busSubscription = this.bus
      .all()
      .subscribe((event) =>
        this.server.to(room(event.orderId)).emit('order.status', event),
      );
  }

  onModuleDestroy(): void {
    this.busSubscription?.unsubscribe();
  }

  // The return value is the ack (the client sends an ack callback).
  @SubscribeMessage('join')
  async join(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<JoinAck> {
    const parsed = JoinPayload.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'invalid_payload' };

    const { orderId } = parsed.data;
    let order: OwnedOrder | null;
    try {
      order = await this.ordersService.findOwnedOrder({
        orderId,
        userId: socket.data.userId,
      });
    } catch (err) {
      // A throw would never ack; the client would just time out.
      this.logger.error(err);
      return { ok: false, error: 'unavailable' };
    }
    // Unknown and foreign orders get the same answer.
    if (!order) return { ok: false, error: 'not_found' };

    await socket.join(room(orderId));
    return { ok: true, orderId, ...order };
  }
}
