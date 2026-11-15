import { Injectable } from '@nestjs/common';

// How many order.placed events this process failed to publish: the order was
// committed, and its event exists only as a log line. GET /health shows the count,
// so a broker outage is visible as a number and not only in the logs.
//
// In memory: per process, and reset on restart. It makes the loss visible; it
// doesn't recover anything. The outbox (HW#22) makes these events durable.
@Injectable()
export class OrderPlacedFailures {
  private count = 0;

  // Returns the new total, for the log line.
  record(): number {
    return ++this.count;
  }

  get total(): number {
    return this.count;
  }
}
