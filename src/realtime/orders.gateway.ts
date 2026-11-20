import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import type { DefaultEventsMap, Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { VERIFICATION_KEYS } from '../auth/access-token.guard.js';
import { verifyAccessToken, type VerificationKeys } from '../auth/tokens.js';
import type { OrderStatus } from '../entities/index.js';
import { OrderEventsBus } from '../order-events/order-events.bus.js';
import { OrdersService } from '../orders/orders.service.js';

const room = (orderId: number) => `orders:${orderId}`;

// What the handshake check leaves on each socket.
interface SocketData {
  userId: number;
}
type OrdersSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;
type OrdersNamespace = Namespace<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

// Handshake `auth`: the same access token the HTTP routes take (io(url, { auth:
// { token } })). The user id comes from the verified token, never from the client.
const Handshake = z.object({ token: z.string().min(1) });

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
  @WebSocketServer() private readonly server!: OrdersNamespace;

  constructor(
    private readonly bus: OrderEventsBus,
    private readonly ordersService: OrdersService,
    @Inject(VERIFICATION_KEYS) private readonly keys: VerificationKeys,
  ) {}

  // Runs once, before any client connects.
  afterInit(server: OrdersNamespace): void {
    // Authentication, before the connection exists: no token, or one that fails the
    // same checks as on HTTP (signature, ES256, iss, aud, exp, kid) → connect_error
    // "unauthorized". The HTTP guard doesn't run for WebSocket connections, so this
    // is the socket's only check. Identity lives in socket.data from here on, never
    // in message bodies.
    server.use((socket, next) => {
      const parsed = Handshake.safeParse(socket.handshake.auth);
      if (!parsed.success) return next(new Error('unauthorized'));
      verifyAccessToken(parsed.data.token, this.keys).then(
        (user) => {
          socket.data.userId = Number(user.id);
          // A socket outlives its handshake: close it when the token expires, so a
          // connection never lasts longer than the token that opened it.
          const expiry = setTimeout(() => socket.disconnect(true), Math.max(0, user.exp * 1000 - Date.now()));
          socket.once('disconnect', () => clearTimeout(expiry));
          next();
        },
        (error: { code?: string }) => {
          // The reason, never the token.
          this.logger.warn(`socket handshake rejected: ${error.code ?? 'ERR_UNKNOWN'}`);
          next(new Error('unauthorized'));
        },
      );
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
    @ConnectedSocket() socket: OrdersSocket,
    @MessageBody() body: unknown,
  ): Promise<JoinAck> {
    const parsed = JoinPayload.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'invalid_payload' };

    const { orderId } = parsed.data;
    const { userId } = socket.data;
    try {
      // Ownership, then join, then the snapshot for the ack. Joined before the
      // snapshot is read, an event committed meanwhile either reaches the room live
      // or is already counted in lastEventId (the client drops live events with
      // eventId <= lastEventId). Read-then-join loses an event committed between
      // the two, and the ack's lastEventId doesn't show it.
      const owned = await this.ordersService.findOwnedOrder({
        orderId,
        userId,
      });
      // Unknown and foreign orders get the same answer.
      if (!owned) return { ok: false, error: 'not_found' };

      await socket.join(room(orderId));
      const snapshot = await this.ordersService.findOwnedOrder({
        orderId,
        userId,
      });
      if (!snapshot) throw new Error(`Order ${orderId} vanished during join.`);
      return { ok: true, orderId, ...snapshot };
    } catch (err) {
      // A throw would never ack; the client would just time out. Not joined either:
      // a client told 'unavailable' mustn't keep receiving the order's events.
      this.logger.error(err);
      await socket.leave(room(orderId));
      return { ok: false, error: 'unavailable' };
    }
  }
}
