import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DbModule } from '../db/db.module.js';
import { ProductsController } from './products.controller.js';
import { ProductsRepository } from './products.repository.js';
import { ProductsService } from './products.service.js';

@Module({
  imports: [DbModule],
  controllers: [ProductsController],
  providers: [
    {
      provide: ProductsRepository,
      useFactory: (dataSource: DataSource) => new ProductsRepository(dataSource.manager),
      inject: [DataSource],
    },
    ProductsService,
  ],
})
export class ProductsModule {}
