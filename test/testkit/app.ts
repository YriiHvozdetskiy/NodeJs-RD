import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { APP_OPTIONS, configureApp } from '../../src/app.setup';
import type { TestPostgres } from './postgres';

/**
 * Повний застосунок — `AppModule` без жодної підміни провайдерів — поверх
 * Postgres із testcontainers. Конфігурація та сама, що в main.ts
 * (`configureApp`): префікс `/v1`, валідатор спеки, problem+json.
 */
export async function bootApp(pg: TestPostgres): Promise<NestExpressApplication> {
  Object.assign(process.env, await pg.appEnv());

  // Імпорт динамічний і ПІСЛЯ env — не для краси. AppModule валідує оточення
  // в момент імпорту: `ConfigModule.forRoot()` стоїть в аргументі @Module і
  // виконується разом із файлом. Статичний import угорі виконався б до старту
  // контейнера, коли DB_URL ще немає, і zod завалив би весь файл.
  const { AppModule } = await import('../../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  // Логер лише для warn/error — інакше кожен файл друкує десятки рядків
  // InstanceLoader. На поведінку застосунку це не впливає.
  const app = moduleRef.createNestApplication<NestExpressApplication>({ ...APP_OPTIONS, logger: ['error', 'warn'] });
  configureApp(app);
  await app.init();
  return app;
}
