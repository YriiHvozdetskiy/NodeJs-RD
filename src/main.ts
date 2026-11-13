import 'reflect-metadata';
import { setTimeout as sleep } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_OPTIONS, configureApp } from './app.setup';
import type { Env } from './config/env.schema';
import { DatabaseService } from './db/database.service';
import { Lifecycle } from './health/lifecycle';

/** Пауза між спробами першого зʼєднання з БД під час прогріву. */
const DB_RETRY_MS = 500;

async function bootstrap(): Promise<void> {
  // Конфіг на цей момент УЖЕ провалідований, і не цим рядком: `validate`
  // виконується під час завантаження app.module — `ConfigModule.forRoot()`
  // стоїть в аргументі декоратора @Module. Тому зламане оточення вбиває процес
  // ще до входу сюди, а catch наприкінці файлу ловить те, що ламається пізніше:
  // зайнятий порт, недоступний файл спеки.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, APP_OPTIONS);

  // Префікс, валідатор спеки, фільтр помилок — src/app.setup.ts.
  // Ту саму функцію викликають E2E-тести й provider verification.
  configureApp(app);

  // Типізований конфіг замість сирого оточення. Другий параметр `true` каже
  // «значення вже провалідовані», тому `get()` повертає точний тип поля без
  // `undefined` — тип виведено зі схеми, а не написано руками вдруге.
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  const warmupMs = config.get('WARMUP_MS', { infer: true });
  const drainMs = config.get('DRAIN_MS', { infer: true });
  const lifecycle = app.get(Lifecycle);
  const db = app.get(DatabaseService);

  // Обробник — ДО прогріву: под можуть зупинити ще до того, як він став готовим.
  let listening = false;
  onTerminate(app, lifecycle, () => (listening ? drainMs : 0));

  if (warmupMs > 0) {
    console.log(`[warmup] ${warmupMs} мс до listen() — слухача ще немає`);
    await sleep(warmupMs);
  }

  await app.listen(port);
  listening = true;
  console.log(`Marketplace API → http://localhost:${port}/v1`);
  console.log(`health → /health (liveness) · /health/ready (readiness) · /health/db`);
  console.log('Валідація запитів і відповідей проти openapi/openapi.yaml: увімкнена');
  if (config.get('DRIFT', { infer: true })) {
    console.log('DRIFT=1 — сервер навмисно віддає totalCents замість total_cents');
  }

  // Готовий — це не «слухач стоїть», а «можу обслужити запит». Без бази жоден
  // бізнес-запит не пройде, тому під трафік под стає лише після першого
  // вдалого зʼєднання з нею. Liveness при цьому вже зелена: процес живий, і
  // вбивати його за повільну базу не можна.
  void (async () => {
    for (let attempt = 1; !lifecycle.isDraining; attempt += 1) {
      try {
        await db.query('SELECT 1');
        lifecycle.markWarm();
        console.log(`[ready] перше зʼєднання з БД — спроба ${attempt}; /health/ready = 200`);
        return;
      } catch (err) {
        if (attempt === 1) console.warn(`[warmup] БД ще недоступна: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(DB_RETRY_MS);
      }
    }
  })();
}

/**
 * SIGTERM — від kubelet під час rolling update, drain вузла чи `docker stop`.
 * Порядок не косметика:
 *   1. readiness → 503. kubelet бачить це на наступній пробі, EndpointSlice
 *      втрачає под, kube-proxy переписує правила. Усе це — не миттєво.
 *   2. Дренаж: процес ще відповідає на все, що встигло прийти за цей час.
 *   3. `app.close()` — сокет закривається, уже прийняті запити дороблюються,
 *      пули БД і Redis закриваються в хуках модулів.
 * `close()` одразу (що робив `enableShutdownHooks`) — відмова новим зʼєднанням
 * у той момент, коли трафік на под ще йде.
 *
 * Node у distroless — PID 1. Для PID 1 ядро не застосовує дефолтну дію до
 * сигналу без обробника, тож без цього коду процес ігнорував би SIGTERM і
 * чекав SIGKILL після terminationGracePeriodSeconds.
 */
function onTerminate(app: NestExpressApplication, lifecycle: Lifecycle, drainFor: () => number): void {
  const handler = (signal: NodeJS.Signals): void => {
    if (lifecycle.isDraining) return;
    lifecycle.startDraining();
    const drainMs = drainFor();
    console.log(`[${signal}] readiness=503, дренаж ${drainMs} мс, потім close()`);
    setTimeout(() => {
      app.close().then(
        () => {
          console.log('[bye] сокет і пули закрито, вихід 0');
          process.exit(0);
        },
        (err: unknown) => {
          console.error(`[bye] close() впав: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        },
      );
    }, drainMs);
  };
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
}

bootstrap().catch((err: unknown) => {
  // Зламаний конфіг має вбити процес ЗІ ЗРОЗУМІЛОЮ помилкою і ненульовим
  // кодом виходу — саме на це дивиться CI й оркестратор. Стектрейс тут не
  // потрібен: помилка не в коді, а в оточенні, і в ній уже названі змінні.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
