import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_OPTIONS, configureApp } from './app.setup';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  // Конфіг на цей момент УЖЕ провалідований, і не цим рядком: `validate`
  // виконується під час завантаження app.module — `ConfigModule.forRoot()`
  // стоїть в аргументі декоратора @Module. Тому зламане оточення вбиває процес
  // ще до входу сюди, а catch наприкінці файлу ловить те, що ламається пізніше:
  // зайнятий порт, недоступний файл спеки.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, APP_OPTIONS);

  // Префікс, валідатор спеки, фільтр помилок, shutdown hooks — src/app.setup.ts.
  // Ту саму функцію викликають E2E-тести й provider verification.
  configureApp(app);

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
