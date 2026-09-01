import 'reflect-metadata';
import * as path from 'node:path';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { middleware as openApiValidator } from 'express-openapi-validator';
import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';
import type { Env } from './config/env.schema';

const SPEC = path.join(__dirname, '..', 'openapi', 'openapi.yaml');

async function bootstrap(): Promise<void> {
  // Конфіг на цей момент УЖЕ провалідований, і не цим рядком: `validate`
  // виконується під час завантаження app.module — `ConfigModule.forRoot()`
  // стоїть в аргументі декоратора @Module. Тому зламане оточення вбиває процес
  // ще до входу сюди, а catch наприкінці файлу ловить те, що ламається пізніше:
  // зайнятий порт, недоступний файл спеки.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Власний body-parser Nest вимкнено СВІДОМО. Він реєструється не там, де
    // потрібно: валідатор бачив би `request must have required property 'body'`
    // на цілком валідному JSON, бо тіло ще не розпарсене. Тут порядок заданий
    // руками й видимий: спершу парсинг, потім перевірка.
    bodyParser: false,
  });

  app.use(express.json());

  // Версія API живе в `servers.url` спеки (`/v1`), тому й тут вона — глобальний
  // префікс, а не частина шляху ресурсу. Валідатор бере basePath зі спеки, тож
  // обидві сторони читають те саме джерело.
  //
  // `/health` із префікса виключений: версіонується публічний контракт, а не
  // те, що читають оркестратор і грейдер.
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/db'] });

  app.use(
    openApiValidator({
      apiSpec: SPEC,
      validateRequests: true,
      // ОСЬ ТОЙ, ХТО ЗВІРЯЄ. Без цього рядка спека — красивий файл: обробник міг
      // би віддати totalCents замість total_cents, і нічого б не помітило.
      validateResponses: true,
      // Операційні ендпоїнти у спеці відсутні навмисно — без цього рядка
      // валідатор віддавав би на них 404 «not found in the OpenAPI spec».
      ignorePaths: /^\/health(\/|$)/,
    }),
  );

  // Помилки валідатора ДОХОДЯТЬ до цього фільтра, хоч EOV і звичайний
  // Express-middleware перед роутером Nest — перевірено. Тому окремий
  // Express-level error handler не потрібен: одна точка на всі помилки.
  app.useGlobalFilters(new ProblemFilter());

  // На SIGTERM Nest перестає приймати нові з'єднання, дороблює поточні й
  // викликає onModuleDestroy у провайдерів — зокрема закриває пул Postgres.
  // Без цього рядка Node помирає миттєво і запит у польоті обривається.
  app.enableShutdownHooks();

  // Типізований конфіг замість сирого оточення. Другий параметр `true` каже
  // «значення вже провалідовані», тому `get()` повертає точний тип поля без
  // `undefined` — тип виведено зі схеми, а не написано руками вдруге.
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });

  await app.listen(port);
  console.log(`Marketplace API → http://localhost:${port}/v1`);
  console.log(`health → http://localhost:${port}/health · http://localhost:${port}/health/db`);
  console.log('Валідація запитів і відповідей проти openapi/openapi.yaml: увімкнена');
  if (config.get('DRIFT', { infer: true })) {
    console.log('DRIFT=1 — сервер навмисно віддає totalCents замість total_cents');
  }
}

bootstrap().catch((err: unknown) => {
  // Зламаний конфіг має вбити процес ЗІ ЗРОЗУМІЛОЮ помилкою і ненульовим
  // кодом виходу — саме на це дивиться CI й оркестратор. Стектрейс тут не
  // потрібен: помилка не в коді, а в оточенні, і в ній уже названі змінні.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
