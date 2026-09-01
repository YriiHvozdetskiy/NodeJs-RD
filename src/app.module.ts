import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/env.schema';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { CatalogService } from './catalog/catalog.service';
import { ProductsController } from './catalog/products.controller';
import { OrdersService } from './orders/orders.service';
import { OrdersController } from './orders/orders.controller';
import { IdempotencyService } from './orders/idempotency.service';

/**
 * Один модуль на весь сервіс — на #13 сюди приїде `TypeOrmModule`, і тоді його
 * варто буде розрізати на CatalogModule / OrdersModule. Різати зараз, коли
 * провайдерів чотири, — вигадана складність.
 */
@Module({
  imports: [
    // `isGlobal` — щоб `ConfigService` був доступний у будь-якому модулі без
    // повторного імпорту; `validate` — наша zod-функція.
    //
    // Ключове тут — не сама перевірка, а МОМЕНТ: `validate` виконується до
    // створення DI-графа. Впала — жоден провайдер не сконструювався, порт не
    // відкрився, процес вийшов з кодом ≠ 0. Це і є fail-fast: зламаний конфіг
    // видно на старті в CI, а не на першому запиті в проді о третій ночі.
    //
    // `.env` читає dotenv усередині ConfigModule і кладе значення у
    // оточення процесу ДО виклику validate — тому локально файл замінює справжнє
    // оточення, а в контейнері його просто немає, і змінні приходять ззовні.
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
      envFilePath: '.env',
      cache: true,
    }),
    DbModule,
  ],
  controllers: [HealthController, ProductsController, OrdersController],
  providers: [CatalogService, OrdersService, IdempotencyService],
})
export class AppModule {}
