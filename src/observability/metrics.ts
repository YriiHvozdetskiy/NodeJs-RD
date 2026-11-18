import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * Метрики RED (#29): Rate — скільки запитів, Errors — скільки з них 5xx,
 * Duration — скільки чекав клієнт. Модель PULL: застосунок лише рахує в
 * памʼяті, а Prometheus сам приходить по `GET /metrics` і забирає текст.
 *
 * Реєстр — один на процес, на рівні модуля, і власний, а не глобальний
 * `register` prom-client. AppModule в одному процесі збирається кілька разів
 * (тести, demo:session перезапускає застосунок): повторна реєстрація метрики
 * з тим самим імʼям кинула б виняток, а модуль вантажиться рівно раз.
 */
export const metricsRegistry = new Registry();

// Памʼять процесу, event loop lag, GC — без них RED не відповідає на «чому повільно».
collectDefaultMetrics({ register: metricsRegistry });

/**
 * Лейбли — лише з обмеженою множиною значень:
 *   method — кілька HTTP-методів;
 *   route  — шаблон маршруту (src/observability/route.ts), не сирий шлях;
 *   status — HTTP-код відповіді: саме по ньому фільтр 5xx на дашборді.
 * userId, orderId, trace_id сюди не йдуть ніколи: кожне нове значення лейбла —
 * новий часовий ряд, і сто id = сто рядів (README, Observability).
 */
const LABELS = ['method', 'route', 'status'] as const;

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP-запити, обслужені застосунком (R і E у RED)',
  labelNames: LABELS,
  registers: [metricsRegistry],
});

/**
 * Межі бакетів, с. Перцентиль із гістограми точний рівно настільки, наскільки
 * дрібні бакети біля нього, а вище за найбільший скінченний `le` він не
 * піднімається ніколи: усе, що довше, лягає в +Inf, і histogram_quantile
 * показує рівну «здорову» лінію саме тоді, коли все погано.
 *
 * Звичайний запит маршруту — одиниці мілісекунд: там бакети густі (5–50 мс).
 * Найгірший випадок, який я бачив, — повільний запит до бази в demo:metrics
 * (1,2 с) і перший запит після старту. Верхній скінченний `le` = 10 с — з
 * восьмикратним запасом над найгіршим. Чому саме ці межі — README, Observability.
 */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Тривалість HTTP-запиту від першого middleware до закриття відповіді (D у RED)',
  labelNames: LABELS,
  buckets: DURATION_BUCKETS,
  registers: [metricsRegistry],
});
