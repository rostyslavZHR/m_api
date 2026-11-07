// The demos' side of the app: a Nest application context with just the orders
// module (no HTTP server, no WebSocket gateway), so an order goes through the real
// OrdersService.create: the checkout transaction, the creation row, and the
// publisher with its confirm. The grader never starts the API, so the demos can't
// call POST /orders.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DataSource, MoreThanOrEqual, Not } from 'typeorm';
import { validate } from '../config/env.schema.js';
import { ProductEntity, UserEntity } from '../entities/index.js';
import type { OrderPlacedEvent } from '../messaging/order-placed.js';
import { OrderPlacedPublisher } from '../messaging/order-placed.publisher.js';
import { OrdersModule } from '../orders/orders.module.js';
import { OrdersService } from '../orders/orders.service.js';
import {
  MESSAGING_BUYER_EMAIL,
  RACE_PRODUCT,
  USER_BALANCE_CENTS,
} from '../seed-fixtures.js';
import { SetupError, log } from './lib.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate }), OrdersModule],
})
class DemoShopModule {}

export interface Shop {
  dataSource: DataSource;
  // Places `count` orders of one unit each; returns every event the publisher was
  // asked to send, and whether its confirm came back.
  placeOrders(count: number): Promise<{ eventIds: string[]; published: number }>;
  close(): Promise<void>;
}

export async function openShop(): Promise<Shop> {
  // Errors only, and Nest's logger writes them to stderr: stdout stays for results.
  // abortOnError false: a failed boot (DB down) throws to runDemo, which exits 2,
  // instead of Nest ending the process with its own exit code.
  const app = await NestFactory.createApplicationContext(DemoShopModule, {
    logger: ['error'],
    abortOnError: false,
  });
  const dataSource = app.get(DataSource);
  const orders = app.get(OrdersService);

  // Observes the real publisher without changing it: every event OrdersService
  // hands over, and whether it was confirmed. The demo's eventIds come from here.
  const publisher = app.get(OrderPlacedPublisher);
  const publish = publisher.publish.bind(publisher);
  const sent: { eventId: string; ok: boolean }[] = [];
  publisher.publish = async (event: OrderPlacedEvent) => {
    const ok = await publish(event);
    sent.push({ eventId: event.eventId, ok });
    return ok;
  };

  const placeOrders = async (count: number) => {
    // The buyer's balance is reset every run, like demo:race does for its buyer.
    const users = dataSource.getRepository(UserEntity);
    await users.update(
      { email: MESSAGING_BUYER_EMAIL },
      { balanceCents: String(USER_BALANCE_CENTS) },
    );
    const buyer = await users.findOneBy({ email: MESSAGING_BUYER_EMAIL });
    // The cheapest product that still has the units, skipping the race demo's.
    // Each run takes 1–5 units, so 10 products × 100 seeded units last for well
    // over 100 runs; `npm run seed` restores the stock.
    const product = await dataSource.getRepository(ProductEntity).findOne({
      where: { stock: MoreThanOrEqual(count), name: Not(RACE_PRODUCT.name) },
      order: { priceCents: 'ASC', id: 'ASC' },
    });
    if (!buyer || !product) {
      throw new SetupError(
        `no ${buyer ? `product with ${count} units in stock` : `user ${MESSAGING_BUYER_EMAIL}`}: run npm run seed`,
      );
    }

    const before = sent.length;
    for (let i = 0; i < count; i++) {
      await orders.create(randomUUID(), {
        user_id: Number(buyer.id),
        items: [{ product_id: Number(product.id), quantity: 1 }],
      });
    }
    const run = sent.slice(before);
    if (run.length !== count) {
      throw new SetupError(
        `${count} orders placed, but ${run.length} events built (see the log above)`,
      );
    }
    log(
      `placed ${count} order(s) of product ${product.id}; eventIds ${run.map((e) => e.eventId).join(', ')}`,
    );
    return {
      eventIds: run.map((e) => e.eventId),
      published: run.filter((e) => e.ok).length,
    };
  };

  return { dataSource, placeOrders, close: () => app.close() };
}

// The effect, from the database, for this run's events only: earlier runs'
// invoices stay in the table and don't count.
export async function countInvoices(
  dataSource: DataSource,
  eventIds: string[],
): Promise<number> {
  const [{ count }] = await dataSource.query<{ count: string }[]>(
    'SELECT count(*) FROM invoices WHERE event_id = ANY($1::bigint[])',
    [eventIds],
  );
  return Number(count);
}
