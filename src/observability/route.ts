/**
 * Лейбл `route` — шаблон маршруту, а не сирий шлях (#29).
 *
 * `/v1/orders/1`, `/v1/orders/2`, … як значення лейбла — це новий часовий ряд
 * на кожен id: лічильник множиться на кількість замовлень, гістограма — ще й
 * на кількість бакетів. Шаблон `/v1/orders/:orderId` — один ряд на всі id.
 * Тому шлях запиту в лейбл не потрапляє НІКОЛИ: те, що не вдалось звести до
 * шаблону, стає константою `unmatched`.
 */
export const UNMATCHED_ROUTE = 'unmatched';

/** Проби оркестратора й скрейп метрик — не трафік: ні в RED, ні в трейси, ні в лог доступу. */
export function isOperationalPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/metrics' || path === '/health' || path.startsWith('/health/');
}

function field(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null ? Reflect.get(source, key) : undefined;
}

/**
 * Шаблон маршруту в момент завершення запиту. Три джерела, від точнішого:
 *   1. `req.route` — Express кладе його, коли роутер Nest знайшов обробник;
 *      там уже повний шлях із префіксом: `/v1/orders/:orderId`;
 *   2. `req.openapi.expressRoute` — валідатор спеки зіставив шлях зі спекою,
 *      але відмовив до роутера (400 на `GET /v1/orders/abc`);
 *   3. `res.locals.route` — middleware, що відповідає ще раніше, називає
 *      маршрут сам (429 від rate-limit, src/rate-limit/orders-rate-limit.ts).
 * Приймає `object`, бо викликається і з Express-middleware, і з хука OTel,
 * де це голі `IncomingMessage` / `ServerResponse` — ті самі обʼєкти.
 */
export function routeOf(req: object, res: object): string {
  const route = field(req, 'route');
  const path = field(route, 'path');
  if (typeof path === 'string') {
    const base = field(req, 'baseUrl');
    return `${typeof base === 'string' ? base : ''}${path}`;
  }
  const expressRoute = field(field(req, 'openapi'), 'expressRoute');
  if (typeof expressRoute === 'string') return expressRoute;
  const hint = field(field(res, 'locals'), 'route');
  if (typeof hint === 'string') return hint;
  return UNMATCHED_ROUTE;
}
