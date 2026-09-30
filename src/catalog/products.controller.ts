import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ProductsRepository, type Product } from './products.repository';
import { HttpProblem } from '../common/http-problem';
import type { Page } from '../common/cursor';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsRepository) {}

  /**
   * Ні `limit`, ні `cursor` тут не перевіряються: діапазон `1..100` і типи вже
   * тримає спека, і валідатор відкидає запит до входу в контролер. `DefaultValuePipe`
   * лишається лише щоб TypeScript бачив number, а не `string | undefined`.
   */
  @Get()
  list(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ): Promise<Page<Product>> {
    return this.products.page(limit, cursor);
  }

  @Get(':productId')
  async one(@Param('productId', ParseIntPipe) productId: number): Promise<Product> {
    const product = await this.products.findById(productId);
    if (!product) throw new HttpProblem(404, `товару ${productId} не існує`, 'not-found');
    return product;
  }
}
