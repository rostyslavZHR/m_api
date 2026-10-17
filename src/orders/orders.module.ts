import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DbModule } from '../db/db.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersRepository } from './orders.repository.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [DbModule],
  controllers: [OrdersController],
  providers: [
    {
      provide: OrdersRepository,
      useFactory: (dataSource: DataSource) => new OrdersRepository(dataSource.manager),
      inject: [DataSource],
    },
    OrdersService,
  ],
})
export class OrdersModule {}
