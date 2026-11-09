import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { APP_OPTIONS, configureApp } from '../../src/app.setup';
import { AccessDenylist } from '../../src/auth/access-denylist';
import { authEnv, MemoryDenylist } from './auth';
import type { TestPostgres } from './postgres';

/**
 * Повний застосунок — `AppModule` поверх Postgres із testcontainers.
 * Конфігурація та сама, що в main.ts (`configureApp`): префікс `/v1`,
 * валідатор спеки, problem+json, гарди автентифікації й ролей.
 *
 * Підміна провайдерів рівно одна — денилист access-токенів (#24). Справжній
 * живе в Redis черги, а тести ходять без Redis; без підміни AuthGuard чесно
 * відповідав би 503 «не вдалось перевірити відкликання» на кожен запит із
 * токеном. Сам денилист у Redis доводять demo:auth і demo:reuse.
 */
export async function bootApp(pg: TestPostgres): Promise<NestExpressApplication> {
  Object.assign(process.env, await pg.appEnv(), authEnv());

  // Імпорт динамічний і ПІСЛЯ env — не для краси. AppModule валідує оточення
  // в момент імпорту: `ConfigModule.forRoot()` стоїть в аргументі @Module і
  // виконується разом із файлом. Статичний import угорі виконався б до старту
  // контейнера, коли DB_URL ще немає, і zod завалив би весь файл.
  const { AppModule } = await import('../../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AccessDenylist)
    .useValue(new MemoryDenylist())
    .compile();
  // Логер лише для warn/error — інакше кожен файл друкує десятки рядків
  // InstanceLoader. На поведінку застосунку це не впливає.
  const app = moduleRef.createNestApplication<NestExpressApplication>({ ...APP_OPTIONS, logger: ['error', 'warn'] });
  configureApp(app);
  await app.init();
  return app;
}
