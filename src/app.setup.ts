import * as path from 'node:path';
import express from 'express';
import { RequestMethod, type NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { middleware as openApiValidator } from 'express-openapi-validator';
import { ProblemFilter } from './common/problem.filter';

/**
 * Спека шукається від кореня запуску, а не від `__dirname`: той самий код
 * лежить у dist/ (прод, Docker) і в dist-test/src/ (тести), і відносний шлях
 * від файла розʼїхався б. Так само відносно кореня читаються `.env` і
 * `DB_PASSWORD_FILE`.
 */
const SPEC = path.resolve('openapi', 'openapi.yaml');

/**
 * Опції створення застосунку. Власний body-parser Nest вимкнено СВІДОМО: він
 * реєструється не там, де потрібно, і валідатор бачив би
 * `request must have required property 'body'` на цілком валідному JSON, бо тіло
 * ще не розпарсене. Порядок задає `configureApp`: спершу парсинг, потім перевірка.
 */
export const APP_OPTIONS: NestApplicationOptions = { bodyParser: false };

/**
 * Усе, що робить застосунок саме цим застосунком, — в одному місці. Його
 * викликають і `main.ts`, і тести: E2E, зібраний без префікса чи валідатора,
 * тестував би інший сервіс, ніж той, що в проді.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  app.use(express.json());

  // Версія API живе в `servers.url` спеки (`/v1`), тому й тут вона — глобальний
  // префікс, а не частина шляху ресурсу. Валідатор бере basePath зі спеки, тож
  // обидві сторони читають те саме джерело.
  //
  // `/health` із префікса виключений: версіонується публічний контракт, а не
  // те, що читають оркестратор і грейдер.
  //
  // SSE-потік `/orders/:id/events` — теж поза `/v1`: це не JSON-ресурс, а
  // транспорт подій, як і `/socket.io/` поруч. OpenAPI 3.0 його не описує, і
  // версія JSON-контракту до нього не стосується.
  app.setGlobalPrefix('v1', {
    exclude: ['health', 'health/db', { path: 'orders/:orderId/events', method: RequestMethod.GET }],
  });

  app.use(
    openApiValidator({
      apiSpec: SPEC,
      validateRequests: true,
      // ОСЬ ТОЙ, ХТО ЗВІРЯЄ. Без цього рядка спека — красивий файл: обробник міг
      // би віддати totalCents замість total_cents, і нічого б не помітило.
      validateResponses: true,
      // Операційні ендпоїнти й SSE-потік у спеці відсутні навмисно — без цього
      // рядка валідатор віддавав би на них 404 «not found in the OpenAPI spec».
      ignorePaths: /^\/(health(\/|$)|orders\/[^/]+\/events$)/,
    }),
  );

  // Помилки валідатора ДОХОДЯТЬ до цього фільтра, хоч EOV і звичайний
  // Express-middleware перед роутером Nest — перевірено. Тому окремий
  // Express-level error handler не потрібен: одна точка на всі помилки.
  app.useGlobalFilters(new ProblemFilter());

  // На SIGTERM Nest перестає приймати нові з'єднання, дороблює поточні й
  // викликає onModuleDestroy у провайдерів — зокрема закриває обидва пули.
  // Без цього рядка Node помирає миттєво і запит у польоті обривається.
  app.enableShutdownHooks();

  return app;
}
