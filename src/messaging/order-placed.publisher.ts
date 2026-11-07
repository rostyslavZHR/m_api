import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ChannelModel, type ConfirmChannel, connect } from 'amqplib';
import type { Env } from '../config/env.schema.js';
import type { OrderPlacedEvent } from './order-placed.js';
import { EVENTS_EXCHANGE, ORDER_PLACED_KEY } from './topology.js';

// Connect + publish + confirm, all of it: POST /orders waits at most this long.
const PUBLISH_TIMEOUT_MS = 2_000;

interface Link {
  connection: ChannelModel;
  channel: ConfirmChannel;
}

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no confirm within ${ms} ms`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

// Publishes order.placed to shop.events over one long-lived connection and one
// confirm channel, opened on the first publish (not at boot: the API and the test
// suites start without a broker). The producer never declares topology: the
// bootstrap does (npm run rabbitmq:bootstrap).
@Injectable()
export class OrderPlacedPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(OrderPlacedPublisher.name);
  // The current link, or the attempt to open one. Cleared when it breaks, so the
  // next publish opens a fresh one: that's the whole reconnect strategy.
  private link?: Promise<Link>;

  constructor(private readonly config: ConfigService<Env, true>) {}

  // Never throws, never hangs past PUBLISH_TIMEOUT_MS: the order is already
  // committed, so a broker problem must not turn its 201 into an error. A failed
  // publish is logged with its ids and the event is lost (no outbox until HW#22).
  async publish(event: OrderPlacedEvent): Promise<boolean> {
    try {
      await withTimeout(this.send(event), PUBLISH_TIMEOUT_MS);
      return true;
    } catch (error) {
      this.logger.error(
        `order.placed not published: eventId=${event.eventId} orderId=${event.data.orderId}: ${(error as Error).message}`,
      );
      // A timed-out or failed link may be half-broken: start fresh next time.
      this.discard();
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    const link = this.link;
    this.link = undefined;
    if (!link) return;
    try {
      await (await link).connection.close();
    } catch {
      // Never connected, or the broker is already gone: nothing to close.
    }
  }

  private async send(event: OrderPlacedEvent): Promise<void> {
    const { channel } = await this.open();
    // This message's own confirm: waitForConfirms() would wait for every
    // outstanding publish on the channel, coupling concurrent orders.
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EVENTS_EXCHANGE,
        ORDER_PLACED_KEY,
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true, // delivery_mode 2: written to disk with the quorum queue
          mandatory: true, // returned if nothing at all takes it (see 'return' below)
          messageId: event.eventId, // stable per order: what consumers dedupe on
          type: event.type,
          contentType: 'application/json',
          // Seconds, from occurredAt: the same on every publish of this event.
          timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  private open(): Promise<Link> {
    if (!this.link) {
      const attempt = this.connect(() => {
        if (this.link === attempt) this.link = undefined;
      });
      this.link = attempt;
      attempt.catch(() => {
        if (this.link === attempt) this.link = undefined;
      });
    }
    return this.link;
  }

  private async connect(forget: () => void): Promise<Link> {
    const connection = await connect(
      this.config.get('RABBITMQ_URL', { infer: true }),
      { timeout: PUBLISH_TIMEOUT_MS },
    );
    // An 'error' event with no listener is an uncaught exception: it would take
    // the whole API down when the broker goes away.
    connection.on('error', (error: Error) =>
      this.logger.error(`RabbitMQ connection error: ${error.message}`),
    );
    connection.on('close', forget);

    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', (error: Error) =>
        this.logger.error(`RabbitMQ channel error: ${error.message}`),
      );
      // A closed channel (a 404/406, or the broker gone) ends this link; close its
      // connection too, so a reconnect doesn't leave the old one open.
      channel.on('close', () => {
        forget();
        connection.close().catch(() => {});
      });
      // mandatory + this listener: a message nothing takes comes back here. With
      // the alternate exchange in place, an unknown key goes to shop.unrouted
      // instead, so this fires only if the AE is missing too.
      channel.on(
        'return',
        (message: {
          fields: { routingKey: string };
          properties: { messageId?: string };
        }) =>
          this.logger.error(
            `order.placed returned as unroutable: messageId=${message.properties.messageId} key=${message.fields.routingKey}`,
          ),
      );
      return { connection, channel };
    } catch (error) {
      await connection.close().catch(() => {});
      throw error;
    }
  }

  private discard(): void {
    const link = this.link;
    this.link = undefined;
    link?.then(({ connection }) => connection.close()).catch(() => {});
  }
}
