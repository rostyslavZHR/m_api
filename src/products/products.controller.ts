import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProductsService } from './products.service.js';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll() {
    return this.productsService.findAll();
  }

  @Get(':id/card')
  async card(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const { card, hit } = await this.productsService.getCard(Number(id));
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    return card;
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productsService.getById(Number(id));
  }
}
