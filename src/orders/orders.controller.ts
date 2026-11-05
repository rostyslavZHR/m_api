import {
  Body,
  Controller,
  Get,
  Headers,
  type MessageEvent,
  Param,
  Patch,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import {
  type CreateOrder,
  OrdersService,
  type UpdateOrderStatus,
} from './orders.service.js';
import { catchError, EMPTY, interval, map, merge, type Observable } from 'rxjs';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.ordersService.list(limit, cursor);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ordersService.getById(Number(id));
  }

  @Post()
  create(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: CreateOrder,
  ) {
    return this.ordersService.create(idempotencyKey, body);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() { status }: UpdateOrderStatus) {
    return this.ordersService.updateStatus({ id: Number(id), to: status });
  }

  // Nest subscribes to the returned Observable and writes each value to the response
  // as an SSE message. It unsubscribes when the client disconnects, which runs the
  // stream's teardown. Async, so streamEvents' 404 happens before any headers are sent.
  @Sse(':id/events')
  async events(
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<Observable<MessageEvent>> {
    const events = await this.ordersService.streamEvents({
      orderId: Number(id),
      afterId: Number(lastEventId ?? 0),
    });

    // merge: one stream with the order's events and a heartbeat interleaved as they
    // come. Each event becomes an SSE message (id: for Last-Event-ID, event:, data:),
    // the first one also tells the client to reconnect after 1 s. The `: ping` comment
    // every 15 s keeps idle connections from being closed by proxies; clients ignore it.
    // Unsubscribing from the merge stops both.
    //
    // catchError: on an error after the headers, Nest would write `event: error` with
    // the raw err.message (e.g. DB connection details) and an `id:` from its own
    // counter, which would become the client's Last-Event-ID. Ending the stream
    // instead sends nothing; EventSource reconnects with its real Last-Event-ID. The
    // service has already logged the error.
    return merge(
      events.pipe(
        map((event, i) => ({
          id: String(event.eventId),
          type: 'order.status',
          data: event,
          ...(i === 0 && { retry: 1000 }),
        })),
      ),
      interval(15_000).pipe(map(() => ({ comment: 'ping' }))),
    ).pipe(catchError(() => EMPTY));
  }
}
