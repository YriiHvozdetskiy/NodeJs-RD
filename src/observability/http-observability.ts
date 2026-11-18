import { AsyncResource } from 'node:async_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { parseFault } from './fault';
import { loggerFor } from './logger';
import { httpDuration, httpRequests, metricsRegistry } from './metrics';
import { runInRequestContext, type RequestContext } from './request-context';
import { isOperationalPath, routeOf } from './route';

/**
 * Статус для запиту, клієнт якого пішов раніше, ніж отримав відповідь.
 * Код nginx: справжнього HTTP-статусу в такого запиту немає, а рахувати його
 * треба — інакше обірвані повільні запити зникають із RED саме тоді, коли їх багато.
 */
const CLIENT_CLOSED = '499';

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * ПЕРШЕ middleware застосунку (src/app.setup.ts) — раніше за CORS, rate-limit
 * і валідатор спеки. Звідси три речі:
 *
 *   1. Контекст запиту в AsyncLocalStorage: усе нижче — гард, контролер,
 *      сервіс, репозиторій, колбек pg — виконується всередині `run`.
 *   2. RED: лічильник і гістограма на КОЖЕН запит, включно з 429 від
 *      rate-limit і 400 від валідатора. Middleware, що стоїть нижче, ці
 *      відмови не побачило б, і частка помилок брехала б.
 *   3. Рядок логу доступу — один на запит, останній у його історії.
 *
 * Запис іде на `close`, а не на `finish`: `finish` не настає, якщо клієнт
 * обірвав зʼєднання, а `close` настає завжди.
 */
export function observeHttp(options: { faultInjection: boolean }): RequestHandler {
  const log = loggerFor('http');

  return (req: Request, res: Response, next: NextFunction): void => {
    if (isOperationalPath(req.originalUrl)) return next();

    const context: RequestContext = {
      tenant: header(req, 'x-tenant-id'),
      idempotencyKey: header(req, 'idempotency-key'),
      fault: options.faultInjection ? parseFault(req.headers['x-fault']) : undefined,
    };

    runInRequestContext(context, () => {
      const started = process.hrtime.bigint();

      // Колбек події виконується в контексті того, хто подію ВИПУСТИВ, а не
      // того, хто підписався. `close` випускає сокет — і без bind рядок логу
      // нижче міг би опинитись поза запитом: без trace_id і без userId.
      // AsyncResource.bind фіксує контекст тут і зараз, усередині `run`.
      res.once(
        'close',
        AsyncResource.bind(() => {
          const seconds = Number(process.hrtime.bigint() - started) / 1e9;
          const route = routeOf(req, res);
          const status = res.writableFinished ? String(res.statusCode) : CLIENT_CLOSED;
          const labels = { method: req.method, route, status };
          httpRequests.inc(labels);
          httpDuration.observe(labels, seconds);

          // Заголовки — так, тіла — ні: тіло може нести пароль, refresh-токен,
          // адресу доставки, і redact сховав би лише описані шляхи.
          log.info(
            {
              req: { method: req.method, url: req.originalUrl, headers: req.headers },
              res: { statusCode: res.statusCode },
              route,
              duration_ms: Math.round(seconds * 1e4) / 10,
            },
            'request completed',
          );
        }),
      );

      next();
    });
  };
}

/**
 * `GET /metrics` — текстовий формат Prometheus. Поза `/v1`, поза валідатором
 * спеки і поза гардами: Prometheus токена не має.
 *
 * Той самий порт, що й API, — компроміс локального стенда: хто бачить API,
 * бачить і /metrics (імена маршрутів, лічильники, памʼять процесу). У проді
 * це окремий порт або правило на вході, яке не пускає `/metrics` ззовні
 * (README, Observability → «Свідомо не зроблено»).
 */
export function metricsEndpoint(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET') return next();
    metricsRegistry.metrics().then(
      (text) => {
        res.setHeader('Content-Type', metricsRegistry.contentType);
        res.end(text);
      },
      (err: unknown) => next(err),
    );
  };
}
