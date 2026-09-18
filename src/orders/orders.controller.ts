import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { OrdersService } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.ordersService.list(limit, cursor);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ordersService.findById(Number(id));
  }

  @Post()
  create(@Headers('idempotency-key') idempotencyKey: string, @Body() body: { items: { product_id: number; quantity: number }[] }) {
    return this.ordersService.create(idempotencyKey, body);
  }
}
