// OpenTelemetry — першим імпортом, як у main.ts: інакше http і pg завантажаться
// непропатченими, і в поді не буде ні спанів, ні trace_id у логах.
import { flushTraces, shutdownTraces } from './observability/otel';
import 'reflect-metadata';
import { logger } from './observability/logger';
import { PinoNestLogger } from './observability/nest-logger';
import { startApi } from './redis/demo-kit';

/**
 * Застосунок для демо #29 — окремим процесом, якого демо читає stdout.
 *
 * Окремим, а не в процесі демо, з двох причин:
 *   1. non-json-lines і secret-in-logs рахуються по справжньому stdout
 *      застосунку — усьому, від старту Nest до виходу, — а не по тому, що
 *      демо вирішило вважати логом;
 *   2. процес демо без OTel: його власні запити в базу (прибирання,
 *      користувачі) не стають спанами й не змішуються з трейсом запиту.
 *
 * Звʼязок із демо — IPC: `ready` з адресою після listen(), `flush` → `flushed`
 * після forceFlush() експортера спанів. SIGTERM — закрити застосунок,
 * виштовхнути спани й вийти.
 */

/** 22900 — порт, який Prometheus зі стенда скрейпить як job `marketplace-demo`. */
const port = Number(process.env.DEMO_PORT ?? 22900);

interface PodMessage {
  t: string;
}

function isPodMessage(m: unknown): m is PodMessage {
  return typeof m === 'object' && m !== null && 't' in m && typeof m.t === 'string';
}

async function main(): Promise<void> {
  // Заголовок X-Fault працює лише з цим прапорцем (src/observability/fault.ts).
  process.env.FAULT_INJECTION = '1';
  // 0.0.0.0 — щоб Prometheus у контейнері дотягнувся через host.docker.internal.
  const api = await startApi({ logger: new PinoNestLogger(), port, host: '0.0.0.0' });

  process.on('message', (m: unknown) => {
    if (!isPodMessage(m) || m.t !== 'flush') return;
    flushTraces().then(
      () => process.send?.({ t: 'flushed' }),
      (err: unknown) => process.send?.({ t: 'flushed', error: err instanceof Error ? err.message : String(err) }),
    );
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    api
      .close()
      .then(() => shutdownTraces())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          logger.error({ err }, 'demo pod: зупинка впала');
          process.exit(1);
        },
      );
  };
  process.once('SIGTERM', stop);
  // Демо вбили (Ctrl+C, kill) — IPC-канал рветься. Без цього под пережив би
  // батька, тримав би порт 22900, і кожне наступне демо падало б на EADDRINUSE.
  process.once('disconnect', stop);

  process.send?.({ t: 'ready', url: api.url, pid: process.pid });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'demo pod не стартував');
  process.exit(1);
});
