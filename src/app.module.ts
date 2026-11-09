import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validate, type Env } from './config/env.schema';
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
import { RedisModule } from './redis/redis.module';
import { ProductCardsService } from './catalog/product-cards.service';
import { SessionsService } from './sessions/sessions.service';
import { SessionsController } from './sessions/sessions.controller';
import { OrdersRateLimit } from './rate-limit/orders-rate-limit';
import { AuthKeys } from './auth/keys';
import { AccessTokens } from './auth/access-tokens';
import { AccessDenylist } from './auth/access-denylist';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard, RolesGuard } from './auth/guards';
import { FileStorage } from './files/file-storage';
import { FilesRepository } from './files/files.repository';
import { FilesService } from './files/files.service';
import { FilesController } from './files/files.controller';

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
    RedisModule,
  ],
  controllers: [HealthController, ProductsController, OrdersController, SessionsController, AuthController, FilesController],
  // OrderEventsService — один екземпляр на весь модуль: у нього публікує
  // OrdersService і з нього читають і gateway, і SSE-контролер. Два екземпляри
  // означали б дві шини, і подія з однієї не дійшла б до підписників іншої.
  providers: [
    ProductsRepository,
    ProductCardsService,
    OrdersRepository,
    UsersRepository,
    OrdersService,
    IdempotencyService,
    OrderEventsService,
    OrdersGateway,
    OutboxRelayService,
    SessionsService,
    OrdersRateLimit,
    // Ключі розбираються один раз на старті, із конфігу, який zod уже перевірив.
    { provide: AuthKeys, inject: [ConfigService], useFactory: (config: ConfigService<Env, true>) => AuthKeys.fromConfig(config) },
    AccessTokens,
    AccessDenylist,
    AuthService,
    // Файли (#26): без STORAGE_BUCKET сховище не створюється, і маршрути файлів відповідають 503.
    FileStorage,
    FilesRepository,
    FilesService,
    // Глобальні гарди виконуються в порядку реєстрації: спершу «хто це»
    // (401), потім «чи можна» (403). Обернути порядок — і анонім отримував
    // би 403 замість 401, а клієнт не знав би, що треба залогінитись.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
