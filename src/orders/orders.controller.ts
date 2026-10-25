import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  type CreateOrder,
  OrdersService,
  type UpdateOrderStatus,
} from './orders.service.js';

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
  updateStatus(
    @Param('id') id: string,
    @Body() { status }: UpdateOrderStatus,
  ) {
    return this.ordersService.updateStatus({ id: Number(id), to: status });
  }
}
