import { isSpanContextValid, trace } from '@opentelemetry/api';
import pino, { type LevelWithSilent, type Logger } from 'pino';
import { requestContext } from './request-context';

/**
 * Структурний лог (#29): один рядок — один JSON-обʼєкт у stdout. Жодних файлів
 * і жодного pretty-форматування в процесі: збирає й показує лог платформа
 * (kubelet, Docker, Loki), а читабельний вигляд локально — `| npx pino-pretty`.
 */

/**
 * Шляхи, які pino замінює на `[REDACTED]` ДО серіалізації рядка.
 *
 * redact не шукає слово «password» у всьому обʼєкті — він ховає рівно
 * описані шляхи. `body.password` сховано, `body.credentials.password` — ні,
 * і поїде в лог відкритим. Тому поруч зі списком діє друге правило: тіла
 * запитів у лог доступу не потрапляють зовсім (src/observability/http-observability.ts),
 * а єдине тіло, яке логується, — спроба входу з відомою формою `{ email, password }`.
 */
export const REDACT_PATHS = [
  // Заголовки запиту в лозі доступу: access-токен і cookie сесії (#23, #24).
  'req.headers.authorization',
  'req.headers.cookie',
  // Тіла автентифікації (#24) там, де їх логує контролер.
  'body.password',
  'body.refresh_token',
  // Ті самі ключі на першому рівні будь-якого обʼєкта: logger.info({ password }).
  'password',
  'refresh_token',
  'access_token',
];

/**
 * Корелятор і контекст запиту — у КОЖНОМУ рядку, і жодна функція їх не
 * передає. pino викликає mixin на кожен запис:
 *   • trace_id / span_id — з активного спана OpenTelemetry. Той самий trace_id
 *     приїхав у `traceparent` від клієнта і лежить у спані в Tempo, тож один
 *     ключ відчиняє і лог, і трейс;
 *   • userId, tenant, idempotencyKey — з AsyncLocalStorage (request-context.ts).
 * Поза запитом (старт процесу) спана немає — і полів немає, а не `null`.
 */
function correlation(): Record<string, string> {
  const fields: Record<string, string> = {};
  const span = trace.getActiveSpan()?.spanContext();
  if (span && isSpanContextValid(span)) {
    fields.trace_id = span.traceId;
    fields.span_id = span.spanId;
  }
  const context = requestContext();
  if (context?.userId) fields.userId = context.userId;
  if (context?.tenant) fields.tenant = context.tenant;
  if (context?.idempotencyKey) fields.idempotencyKey = context.idempotencyKey;
  return fields;
}

/**
 * Кореневий логер процесу. LOG_LEVEL читається тут напряму, бо логер
 * потрібен ще до того, як Nest провалідує конфіг: помилку самої валідації
 * теж треба записати JSON-рядком. Значення перевіряє та сама zod-схема.
 */
export const logger: Logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.OTEL_SERVICE_NAME || 'marketplace-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  // "level":"info" замість "level":30 — фільтр у Grafana/Loki пишуть люди.
  formatters: { level: (label) => ({ level: label }) },
  mixin: correlation,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
});

/** Логери шарів — по одному на модуль, створені під час імпорту. */
const layers: Logger[] = [];

/**
 * Логер шару: поле `layer` каже, ЯКИЙ компонент написав рядок —
 * `orders.controller`, `orders.service`, `orders.repository`. Разом із
 * trace_id видно шлях запиту крізь шари без жодного аргументу.
 */
export function loggerFor(layer: string): Logger {
  const child = logger.child({ layer });
  layers.push(child);
  return child;
}


/**
 * Змінити рівень уже після старту. Дочірній логер pino копіює рівень у
 * момент створення і змін батька не бачить, тож рівень ставиться кожному.
 * Кличуть двоє: main.ts — коли конфіг провалідовано і LOG_LEVEL з .env
 * нарешті відомий; startApi() демо попередніх ДЗ — щоб їхній вивід
 * `ключ=значення` не тонув у рядках логу доступу.
 */
export function setLogLevel(level: LevelWithSilent): void {
  logger.level = level;
  for (const child of layers) child.level = level;
}
