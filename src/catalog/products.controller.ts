import { Body, Controller, DefaultValuePipe, Get, HttpCode, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProductsRepository, type NewProduct, type Product, type ProductCard } from './products.repository';
import { ProductCardsService } from './product-cards.service';
import { HttpProblem } from '../common/http-problem';
import type { Page } from '../common/cursor';
import type { Principal } from '../auth/access-tokens';
import { CurrentPrincipal, Public, Roles } from '../auth/guards';

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
  @Public()
  @Get()
  list(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ): Promise<Page<Product>> {
    return this.products.page(limit, cursor);
  }

  /** Картка — через кеш (#23): найгарячіше й найдорожче читання каталогу. */
  @Public()
  @Get(':productId')
  async one(@Param('productId', ParseIntPipe) productId: number): Promise<ProductCard> {
    const card = await this.cards.get(productId);
    if (!card) throw new HttpProblem(404, `товару ${productId} не існує`, 'not-found');
    return card;
  }

  /**
   * Запис у каталог — рівень РОЛІ: вирішує лише роль, сам ресурс ще не
   * існує, і знати про нього гарду нічого. Покупець — 403 від RolesGuard.
   * Продавцем товару стає той, хто прийшов із токеном: `seller_id` у тілі
   * немає свідомо, інакше продавець міг би виставити товар від чужого імені.
   */
  @Roles('seller', 'admin')
  @Post()
  @HttpCode(201)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: NewProduct,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Product> {
    const product = await this.products.create(principal.userId, body);
    res.setHeader('Location', `/v1/products/${product.id}`);
    return product;
  }
}
