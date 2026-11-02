import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ProductsRepository, type Product, type ProductCard } from './products.repository';
import { ProductCardsService } from './product-cards.service';
import { HttpProblem } from '../common/http-problem';
import type { Page } from '../common/cursor';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsRepository,
    private readonly cards: ProductCardsService,
  ) {}

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

  /** Картка — через кеш (#23): найгарячіше й найдорожче читання каталогу. */
  @Get(':productId')
  async one(@Param('productId', ParseIntPipe) productId: number): Promise<ProductCard> {
    const card = await this.cards.get(productId);
    if (!card) throw new HttpProblem(404, `товару ${productId} не існує`, 'not-found');
    return card;
  }
}
