import { Injectable } from '@nestjs/common';
import { filter, Observable, Subject } from 'rxjs';
import { OrderStatusEvent } from './order-status-event.js';

// One in-process channel for committed status changes. A plain Subject, not a
// replaying one: late subscribers get history from order_events, not from memory.
@Injectable()
export class OrderEventsBus {
  private readonly events = new Subject<OrderStatusEvent>();

  publish(event: OrderStatusEvent): void {
    this.events.next(event);
  }

  all(): Observable<OrderStatusEvent> {
    return this.events.asObservable();
  }

  forOrder(orderId: OrderStatusEvent['orderId']): Observable<OrderStatusEvent> {
    return this.all().pipe(filter((event) => event.orderId === orderId));
  }
}
