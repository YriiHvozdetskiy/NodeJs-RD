import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/env.schema';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { ProductsRepository } from './catalog/products.repository';
import { ProductsController } from './catalog/products.controller';
import { OrdersRepository } from './orders/orders.repository';
import { OrdersService } from './orders/orders.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersGateway } from './orders/orders.gateway';
import { OrderEventsService } from './orders/order-events.service';
import { IdempotencyService } from './orders/idempotency.service';
import { UsersRepository } from './users/users.repository';
import { OutboxRelayService } from './outbox/outbox-relay.service';

/**
 * Один модуль на весь сервіс. Розрізати на CatalogModule / OrdersModule варто
 * тоді, коли в них зʼявиться власна конфігурація чи межі доступу (#24), а не
 * лише тому, що провайдерів стало шість.
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
  // OrderEventsService — один екземпляр на весь модуль: у нього публікує
  // OrdersService і з нього читають і gateway, і SSE-контролер. Два екземпляри
  // означали б дві шини, і подія з однієї не дійшла б до підписників іншої.
  providers: [
    ProductsRepository,
    OrdersRepository,
    UsersRepository,
    OrdersService,
    IdempotencyService,
    OrderEventsService,
    OrdersGateway,
    OutboxRelayService,
  ],
})
export class AppModule {}
