import 'reflect-metadata';
import * as path from 'node:path';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { middleware as openApiValidator } from 'express-openapi-validator';
import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';

const SPEC = path.join(__dirname, '..', 'openapi', 'openapi.yaml');
const PORT = Number(process.env.PORT ?? 3000);

async function bootstrap(): Promise<void> {
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
  app.setGlobalPrefix('v1');

  app.use(
    openApiValidator({
      apiSpec: SPEC,
      validateRequests: true,
      // ОСЬ ТОЙ, ХТО ЗВІРЯЄ. Без цього рядка спека — красивий файл: обробник міг
      // би віддати totalCents замість total_cents, і нічого б не помітило.
      validateResponses: true,
    }),
  );

  // Помилки валідатора ДОХОДЯТЬ до цього фільтра, хоч EOV і звичайний
  // Express-middleware перед роутером Nest — перевірено. Тому окремий
  // Express-level error handler не потрібен: одна точка на всі помилки.
  app.useGlobalFilters(new ProblemFilter());

  await app.listen(PORT);
  console.log(`Marketplace API → http://localhost:${PORT}/v1`);
  console.log('Валідація запитів і відповідей проти openapi/openapi.yaml: увімкнена');
  if (process.env.DRIFT === '1') {
    console.log('DRIFT=1 — сервер навмисно віддає totalCents замість total_cents');
  }
}

void bootstrap();
