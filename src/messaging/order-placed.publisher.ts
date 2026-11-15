import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { type ChannelModel, type ConfirmChannel, connect } from 'amqplib';
import { EVENTS_EXCHANGE } from './topology.js';

// Connect + publish + confirm, all of it. Since HW#22 it bounds how long the relay
// can hold its batch's row locks when the broker stalls (#157: a timeout on every
// remote call).
const PUBLISH_TIMEOUT_MS = 2_000;

// One outbox row, as the relay hands it over. The body goes out as stored.
export interface OutboxMessage {
  id: string;
  // The event type, which is also the routing key (order.placed).
  type: string;
  payload: object;
  createdAt: Date;
}

// The link didn't answer in time, so it may be half-broken. Its own class, because
// it's the only failure that should throw the connection away (see publish()).
class ConfirmTimeout extends Error {}

interface Link {
  connection: ChannelModel;
  channel: ConfirmChannel;
}

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ConfirmTimeout(`no confirm within ${ms} ms`)),
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

// Publishes outbox rows to shop.events over one long-lived connection and one
// confirm channel, opened on first use. Since HW#22 the relay is its only user (the
// order path writes to the outbox instead). It never declares topology: the
// bootstrap does (npm run rabbitmq:bootstrap).
export class OrderPlacedPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(OrderPlacedPublisher.name);
  // The current link, or the attempt to open one. Cleared when it breaks, so the
  // next use opens a fresh one: that's the whole reconnect strategy.
  private link?: Promise<Link>;

  constructor(private readonly url: string) {}

  // Opens the link if needed; throws if the broker can't be reached. The relay
  // calls it before taking any row locks, so a broker outage never touches rows.
  async connect(): Promise<void> {
    try {
      await withTimeout(this.open(), PUBLISH_TIMEOUT_MS);
    } catch (error) {
      this.discard();
      throw error;
    }
  }

  // true only once the broker has confirmed this message. Never throws, never hangs
  // past PUBLISH_TIMEOUT_MS. false doesn't mean "not delivered": the broker may have
  // stored it and only the confirm got lost. The relay retries, and the consumer's
  // dedup absorbs the duplicate.
  async publish(message: OutboxMessage): Promise<boolean> {
    try {
      await withTimeout(this.send(message), PUBLISH_TIMEOUT_MS);
      return true;
    } catch (error) {
      this.logger.error(
        `not published: id=${message.id} type=${message.type}: ${(error as Error).message}`,
      );
      // Only a timeout makes the link suspect. A broker nack fails this one message
      // and leaves the channel fine; a closed channel or connection is already
      // forgotten by its 'close' listener. Discarding on every failure would close
      // the connection under the batch's other in-flight publishes, fail their
      // confirms too, and spend an attempt on every row of the batch.
      if (error instanceof ConfirmTimeout) this.discard();
      return false;
    }
  }

  async close(): Promise<void> {
    const link = this.link;
    this.link = undefined;
    if (!link) return;
    try {
      await (await link).connection.close();
    } catch {
      // Never connected, or the broker is already gone: nothing to close.
    }
  }

  onModuleDestroy(): Promise<void> {
    return this.close();
  }

  private async send(message: OutboxMessage): Promise<void> {
    const { channel } = await this.open();
    // This message's own confirm: waitForConfirms() would wait for every
    // outstanding publish on the channel, coupling unrelated messages.
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EVENTS_EXCHANGE,
        message.type,
        Buffer.from(JSON.stringify(message.payload)),
        {
          persistent: true, // delivery_mode 2: written to disk with the quorum queue
          mandatory: true, // returned if nothing at all takes it (see 'return' below)
          messageId: message.id, // the outbox id = the eventId consumers dedupe on
          type: message.type,
          contentType: 'application/json',
          // Seconds, from the row's created_at: the same on every publish of it.
          timestamp: Math.floor(message.createdAt.getTime() / 1000),
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  private open(): Promise<Link> {
    if (!this.link) {
      const attempt = this.openLink(() => {
        if (this.link === attempt) this.link = undefined;
      });
      this.link = attempt;
      attempt.catch(() => {
        if (this.link === attempt) this.link = undefined;
      });
    }
    return this.link;
  }

  private async openLink(forget: () => void): Promise<Link> {
    const connection = await connect(this.url, {
      timeout: PUBLISH_TIMEOUT_MS,
    });
    // An 'error' event with no listener is an uncaught exception: it would take
    // the whole process down when the broker goes away.
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
      // instead (and is confirmed), so this fires only if the AE is missing too.
      channel.on(
        'return',
        (message: {
          fields: { routingKey: string };
          properties: { messageId?: string };
        }) =>
          this.logger.error(
            `returned as unroutable: messageId=${message.properties.messageId} key=${message.fields.routingKey}`,
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
