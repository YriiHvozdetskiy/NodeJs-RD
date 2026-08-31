import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { CatalogService, type Product } from './catalog.service';
import { HttpProblem } from '../common/http-problem';
import type { Page } from '../common/cursor';

@Controller('products')
export class ProductsController {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * Ні `limit`, ні `cursor` тут не перевіряються: діапазон `1..100` і типи вже
   * тримає спека, і валідатор відкидає запит до входу в контролер. `DefaultValuePipe`
   * лишається лише щоб TypeScript бачив number, а не `string | undefined`.
   */
  @Get()
  list(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ): Page<Product> {
    return this.catalog.page(limit, cursor);
  }

  @Get(':productId')
  one(@Param('productId', ParseIntPipe) productId: number): Product {
    const product = this.catalog.find(productId);
    if (!product) throw new HttpProblem(404, `товару ${productId} не існує`, 'not-found');
    return product;
  }
}
