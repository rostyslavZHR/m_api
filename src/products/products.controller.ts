import { Body, Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard.js';
import { type CreateProduct, ProductsService } from './products.service.js';
import { Public } from '../auth/public.decorator.js';
import { Roles } from '../auth/roles.decorator.js';

// @Public() on each read handler, not on the class: the catalog is read without
// logging in (and the Pact contract replays these requests with no token), but a
// class-level @Public() would also open every write route added here, and nothing
// on a handler can say "not public" again.
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Public()
  @Get()
  findAll() {
    return this.productsService.findAll();
  }

  // Rate limited: a card read can cost a database aggregate (a cache miss).
  @Public()
  @Get(':id/card')
  @UseGuards(RateLimitGuard)
  async card(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const { card, hit } = await this.productsService.getCard(Number(id));
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    return card;
  }

  @Public()
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productsService.getById(Number(id));
  }

  // The role level: sellers and admins add products, a customer gets 403. Products
  // have no owner yet, so there is nothing "whose" to check (see the README).
  @Post()
  @Roles('seller', 'admin')
  create(@Body() body: CreateProduct) {
    return this.productsService.create(body);
  }
}
