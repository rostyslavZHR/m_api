import { writeSync } from 'node:fs';

// What the consumer prints on stdout: one JSON object per line, for the demos to
// count. Human-readable logs go to stderr, so stdout carries only these.
export type ConsumerLine =
  | { event: 'ready'; prefetch: number }
  // Written as soon as a message arrives, before the effect.
  | {
      event: 'delivery';
      messageId: string | null;
      redelivered: boolean;
      // x-delivery-count: how many times the broker has handed it out before.
      deliveryCount: number;
    }
  // After the ack: a new invoice, or one an earlier delivery already wrote.
  | { event: 'applied'; messageId: string }
  | { event: 'skipped'; messageId: string }
  | {
      event: 'rejected';
      messageId: string | null;
      requeue: boolean;
      reason: string;
    };

// Synchronous on purpose: Node writes to a pipe asynchronously, so a line passed to
// console.log right before a SIGKILL can be lost. writeSync is on its way to the
// parent before the next statement runs.
export const report = (line: ConsumerLine): void => {
  writeSync(1, `${JSON.stringify(line)}\n`);
};
