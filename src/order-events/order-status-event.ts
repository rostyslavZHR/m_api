import type { OrderEventEntity, OrderStatus } from '../entities/index.js';

// The payload both transports send: SSE's `data:` JSON and the WebSocket
// `order.status` message. It carries its own eventId, because Socket.IO has no
// `id:` field the way SSE does.
export interface OrderStatusEvent {
  eventId: number;
  orderId: number;
  from: OrderStatus | null; // null for the creation event
  to: OrderStatus;
  at: string; // ISO timestamp
}

// bigint ids arrive as strings from pg; they're far below 2^53, so Number is
// exact, and comparing "greater than Last-Event-ID" works on numbers.
export const toStatusEvent = (event: OrderEventEntity): OrderStatusEvent => ({
  eventId: Number(event.id),
  orderId: Number(event.orderId),
  from: event.fromStatus,
  to: event.toStatus,
  at: event.createdAt.toISOString(),
});
