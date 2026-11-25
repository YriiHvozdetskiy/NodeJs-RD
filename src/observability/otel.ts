import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { isOperationalPath, routeOf } from './route';

/**
 * OpenTelemetry (#29). Цей файл — ПЕРШИЙ імпорт процесу (src/main.ts,
 * src/demo-obs-pod.ts), раніше за `reflect-metadata` і за будь-що, що тягне
 * `http` чи `pg`.
 *
 * Автоінструментування — це підміна функцій модуля в момент його `require`
 * (require-in-the-middle). Модуль, завантажений ДО реєстрації, лишається
 * непропатченим: запит обробляється, але спана немає, `traceparent` ніхто не
 * читає, і жодної помилки про це немає. Тому порядок імпортів тут — не стиль,
 * а механізм. Проєкт — CommonJS, тож ESM-хука `import-in-the-middle` не треба.
 *
 * Без OTEL_EXPORTER_OTLP_ENDPOINT експортера немає, але спани й контекст є:
 * trace_id із вхідного `traceparent` однаково потрапляє в кожен рядок логу.
 * Так стартують тести, kind і демо попередніх ДЗ — нікуди нічого не шлючи.
 */

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, '') ?? '';

// Batch, а не Simple: спан не йде в мережу в момент завершення запиту, а
// чекає пачки (до 5 с або 512 спанів). Ціна — останні спани живуть у памʼяті
// процесу, тож перед виходом їх треба виштовхнути: shutdownTraces() нижче.
const spanProcessors: SpanProcessor[] = endpoint
  ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))]
  : [];

export const tracerProvider = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || 'marketplace-api' }),
  spanProcessors,
});

// Глобальний провайдер + W3C Trace Context як пропагатор + контекст на
// AsyncLocalStorage. Саме пропагатор читає вхідний `traceparent`
// (00-<trace-id>-<parent-id>-<flags>) і продовжує ТОЙ САМИЙ trace замість нового.
tracerProvider.register();

registerInstrumentations({
  tracerProvider,
  instrumentations: [
    new HttpInstrumentation({
      // Проби оркестратора й скрейпи Prometheus — не трафік. Спан на кожну
      // пробу раз на 2 с забив би бек трейсів шумом.
      ignoreIncomingRequestHook: (req) => isOperationalPath(req.url ?? ''),
      // Викликається перед завершенням серверного спана, коли Express уже
      // знайшов маршрут. Імʼя спана — шаблон, як і лейбл метрики: `GET
      // /v1/orders/:orderId`, а не сто різних імен для ста id.
      applyCustomAttributesOnSpan: (span, req, res) => {
        const route = routeOf(req, res);
        span.setAttribute('http.route', route);
        span.updateName(`${req.method ?? 'GET'} ${route}`);
      },
    }),
    // requireParentSpan: запит до бази без батьківського спана (прогрів пулу,
    // resync денилиста на старті) не породжує окремого трейсу з одного спана.
    new PgInstrumentation({ requireParentSpan: true }),
  ],
});

/** Виштовхнути накопичені спани зараз — демо чекають на це, перш ніж питати Tempo. */
export function flushTraces(): Promise<void> {
  return tracerProvider.forceFlush();
}

/** Flush + зупинка експортера. Без цього SIGTERM губить останню пачку спанів. */
export function shutdownTraces(): Promise<void> {
  return tracerProvider.shutdown();
}
