import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard.js';
import { ProductsService } from './products.service.js';
import { Public } from '../auth/public.decorator.js';

// Public: the catalog is read without logging in (and the Pact contract replays these
// requests with no token). The card is rate-limited instead.
@Public()
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll() {
    return this.productsService.findAll();
  }

  // Rate limited: a card read can cost a database aggregate (a cache miss).
  @Get(':id/card')
  @UseGuards(RateLimitGuard)
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
