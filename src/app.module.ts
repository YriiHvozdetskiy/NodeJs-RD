import { Module } from '@nestjs/common';
import { CatalogService } from './catalog/catalog.service';
import { ProductsController } from './catalog/products.controller';
import { OrdersService } from './orders/orders.service';
import { OrdersController } from './orders/orders.controller';
import { IdempotencyService } from './orders/idempotency.service';

/**
 * Один модуль на весь сервіс — на #11 сюди приїде `ConfigModule.forRoot()`,
 * на #13 `TypeOrmModule`, і тоді його варто буде розрізати на CatalogModule /
 * OrdersModule. Різати зараз, коли провайдерів чотири, — вигадана складність.
 */
@Module({
  controllers: [ProductsController, OrdersController],
  providers: [CatalogService, OrdersService, IdempotencyService],
})
export class AppModule {}
