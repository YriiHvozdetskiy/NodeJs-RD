import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { cleanup } from './auth/demo-kit';
import { dataSourceOptions } from './data-source';
import { requiredEnv } from './db/cli-env';
import { Summary } from './messaging/demo-kit';
import { buyerWithOrder, isAccessLine, loginAs, ObsPod, request, str, traceparent } from './observability/demo-kit';
import { migrateSchema } from './redis/demo-kit';

/**
 * demo:trace (#29) — один ключ відчиняє двоє дверей.
 *
 *   GET /v1/orders/:id, traceparent 00-<T>-<P>-01, X-Fault: error → 500
 *   forceFlush() у застосунку → спани пішли в Tempo по OTLP
 *   GET <Tempo>/api/traces/<T> → спани ЦЬОГО запиту
 *     trace-matches-header — trace_id спанів = T, батько серверного спана = P;
 *     trace-matches-log    — trace_id і span_id рядка логу є в цьому трейсі;
 *     span-status-error    — серверний спан запиту з 5xx має статус ERROR;
 *     orphan-spans         — спанів, чий батько не в трейсі і не P, немає.
 *
 * Спан бази — справжній: відмова — це `SELECT 1/0` у репозиторії, тож у
 * трейсі видно, ДЕ саме впав запит, а не лише що він упав.
 */
const DEMO = 'obs-trace';
const POLL_TIMEOUT_MS = 20_000;

/** Спан у тому вигляді, в якому його повертає Tempo, зведений до hex і чисел. */
interface SpanView {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  server: boolean;
  error: boolean;
}

const get = (source: unknown, key: string): unknown =>
  typeof source === 'object' && source !== null ? Reflect.get(source, key) : undefined;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Tempo віддає id в JSON-відображенні protobuf — base64; деякі версії — hex. */
function hexId(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || value === '') return '';
  if (new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) return value;
  return Buffer.from(value, 'base64').toString('hex');
}

/** OTLP JSON → плоский список спанів. Kind і статус бувають і рядком-енумом, і числом. */
function spansOf(json: unknown): SpanView[] {
  const spans: SpanView[] = [];
  for (const batch of [...list(get(json, 'batches')), ...list(get(get(json, 'trace'), 'resourceSpans')), ...list(get(json, 'resourceSpans'))]) {
    for (const scope of [...list(get(batch, 'scopeSpans')), ...list(get(batch, 'instrumentationLibrarySpans'))]) {
      for (const span of list(get(scope, 'spans'))) {
        const kind = get(span, 'kind');
        const code = get(get(span, 'status'), 'code');
        spans.push({
          traceId: hexId(get(span, 'traceId'), 16),
          spanId: hexId(get(span, 'spanId'), 8),
          parentSpanId: hexId(get(span, 'parentSpanId'), 8),
          name: String(get(span, 'name') ?? ''),
          server: kind === 'SPAN_KIND_SERVER' || kind === 2,
          error: code === 'STATUS_CODE_ERROR' || code === 2,
        });
      }
    }
  }
  return spans;
}

/**
 * Трейс із Tempo за trace_id. Інгестер приймає спани не миттєво, тож опитуємо
 * до дедлайну, доки два опитування поспіль не дадуть ту саму непорожню
 * кількість: батч міг прийти частинами.
 */
async function fetchTrace(base: string, traceId: string): Promise<SpanView[]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let previous = -1;
  for (;;) {
    const reply = await request(`${base.replace(/\/+$/, '')}/api/traces/${traceId}`);
    const spans = reply.status === 200 ? spansOf(reply.json) : [];
    if (spans.length > 0 && spans.length === previous) return spans;
    previous = spans.length;
    if (Date.now() > deadline) return spans;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<void> {
  const traceApi = requiredEnv('TRACE_API_URL');
  requiredEnv('OTEL_EXPORTER_OTLP_ENDPOINT');

  const summary = new Summary();
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  let pod: ObsPod | undefined;

  try {
    await migrateSchema();
    await cleanup(dataSource, DEMO);
    const { buyer, orderId } = await buyerWithOrder(dataSource, DEMO);
    pod = await ObsPod.start();
    const token = await loginAs(pod, buyer);
    const orderUrl = `${pod.url}/v1/orders/${orderId}`;
    console.log(`── demo:trace: застосунок ${pod.url} → OTLP ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}, Tempo ${traceApi} ──`);

    // Прогрів поза рахунком: перший запит маршруту довший і з іншим набором
    // спанів. Його рядок доступу пишеться вже ПІСЛЯ відповіді — без очікування
    // він опинився б у вікні наступного запиту.
    const warm = traceparent();
    await request(orderUrl, { headers: { authorization: `Bearer ${token}`, traceparent: warm.header } });
    await pod.waitForAccess([warm.traceId]);

    const tp = traceparent();
    const mark = pod.mark();
    const reply = await request(orderUrl, {
      headers: { authorization: `Bearer ${token}`, traceparent: tp.header, 'x-fault': 'error' },
    });
    await pod.waitForAccess([tp.traceId]);
    // BatchSpanProcessor тримає спани до 5 с — без flush Tempo їх ще не бачив.
    await pod.flush();
    const spans = await fetchTrace(traceApi, tp.traceId);

    const ids = new Set(spans.map((span) => span.spanId));
    const server = spans.find((span) => span.server && span.parentSpanId === tp.parentId);
    // Батько серверного спана — span-id клієнта з traceparent: такого спана в
    // трейсі немає, і це не сирота, а межа сервісу. Сирота — усе інше без батька в трейсі.
    const orphans = spans.filter((span) => !ids.has(span.parentSpanId) && span.parentSpanId !== tp.parentId).length;
    const traceMatchesHeader = spans.length > 0 && spans.every((span) => span.traceId === tp.traceId) && server ? 1 : 0;

    // Вікно логу — усе, що застосунок написав за час цього запиту. Рядки
    // шукаємо за роллю (лог доступу, рядок помилки), а не за trace_id: інакше
    // звіряння trace_id зі спаном перевіряло б саме себе.
    const lines = pod.since(mark);
    const access = lines.find(isAccessLine);
    const failure = lines.find((line) => str(line, 'layer') === 'http.problem');
    const inTrace = (line: typeof access): boolean =>
      line !== undefined && str(line, 'trace_id') === server?.traceId && ids.has(str(line, 'span_id') ?? '');
    const traceMatchesLog = server && inTrace(access) && inTrace(failure) ? 1 : 0;
    const statusError = server?.error ? 1 : 0;

    console.log(`   відповідь ${reply.status}; трейс ${tp.traceId}:`);
    for (const span of spans) {
      const parent = span.parentSpanId === tp.parentId ? 'traceparent' : span.parentSpanId || '—';
      console.log(`     ${span.spanId} ← ${parent}  ${span.name}${span.error ? '  [ERROR]' : ''}`);
    }
    if (failure) console.log(`   рядок помилки: layer=http.problem trace_id=${str(failure, 'trace_id')} span_id=${str(failure, 'span_id')}`);
    console.log(`   відкрити: Grafana → Explore → Tempo → ${tp.traceId}`);

    summary.line('status', reply.status);
    summary.line('spans', spans.length);
    summary.line('orphan-spans', orphans);
    summary.line('trace-matches-header', traceMatchesHeader);
    summary.line('trace-matches-log', traceMatchesLog);
    summary.line('span-status-error', statusError);

    summary.expect('status=500 — відмова бази дала 5xx', reply.status === 500);
    summary.expect('spans ≥ 2 — серверний спан і вкладений спан бази', spans.length >= 2);
    summary.expect('orphan-spans=0 — кожен спан має батька в трейсі або в traceparent', orphans === 0);
    summary.expect('trace-matches-header=1 — вхідний traceparent продовжено, а не почато новий трейс', traceMatchesHeader === 1);
    summary.expect('trace-matches-log=1 — trace_id і span_id із логу — у цьому трейсі', traceMatchesLog === 1);
    summary.expect('span-status-error=1 — запит із 5xx дав серверний спан зі статусом ERROR', statusError === 1);
  } finally {
    await pod?.stop();
    await cleanup(dataSource, DEMO).catch(() => undefined);
    await dataSource.destroy();
  }
  summary.finish();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
