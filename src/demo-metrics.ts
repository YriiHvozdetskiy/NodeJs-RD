import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DataSource } from 'typeorm';
import { cleanup } from './auth/demo-kit';
import { dataSourceOptions } from './data-source';
import { Summary } from './messaging/demo-kit';
import { DURATION_BUCKETS } from './observability/metrics';
import { buyerWithOrder, DEMO_ROUTE, loginAs, ObsPod, request, scrape, sum, type Reply, type Sample } from './observability/demo-kit';
import { migrateSchema } from './redis/demo-kit';

/**
 * demo:metrics (#29) — RED рахує те, що сталося, і кардинальність не росте.
 *
 *   прогрів: один GET неіснуючого замовлення (404)
 *   скрейп S0 → series-before
 *   100 GET зі ста різними id (усі 404)
 *   скрейп S1 → series-after = series-before: route — шаблон, а не шлях
 *   RED: 40 звичайних (200) + 5 повільних (200, ~1,2 с) + 15 зламаних (500)
 *   скрейп S2 → counter-delta, errors-delta — різниця S2 − S1;
 *              above-top-bucket — _count − _bucket{le=<верхній скінченний>}
 *   стенд (якщо задано PROMETHEUS_URL і GRAFANA_URL): Prometheus скрейпить
 *              саме цей под, кожна панель дашборда має ряд маршруту, Grafana
 *              віддає провіжений дашборд
 *
 * Повільні й зламані — справжні запити до Postgres (`X-Fault`, src/observability/fault.ts).
 */
const DEMO = 'obs-metrics';
const DISTINCT_IDS = 100;
const FAST = 40;
const SLOW = 5;
const FAILING = 15;
/** Id, яких у базі немає: seed дає сотні тисяч замовлень, а не два мільярди. */
const MISSING_ID = 2_000_000_000;

const TOP_LE = Math.max(...DURATION_BUCKETS);
const onRoute = (labels: Record<string, string>): boolean => labels.route === DEMO_ROUTE;

/** Кількість рядів лічильника — різних наборів лейблів у експозиції. */
const seriesOf = (samples: Sample[]): number => samples.filter((s) => s.name === 'http_requests_total').length;

async function main(): Promise<void> {
  const summary = new Summary();
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  let pod: ObsPod | undefined;

  try {
    await migrateSchema();
    await cleanup(dataSource, DEMO);
    const { buyer, orderId } = await buyerWithOrder(dataSource, DEMO);
    pod = await ObsPod.start();
    const token = await loginAs(pod, buyer);
    console.log(`── demo:metrics: застосунок ${pod.url}, маршрут ${DEMO_ROUTE} ──`);

    const auth = { authorization: `Bearer ${token}` };
    const get = (id: number | string, fault?: 'error' | 'slow'): Promise<Reply> =>
      request(`${pod?.url}/v1/orders/${id}`, { headers: fault ? { ...auth, 'x-fault': fault } : auth });

    // ── Кардинальність ────────────────────────────────────────────────────
    // Прогрів тим самим методом, маршрутом і статусом, що й сотня нижче: ряд
    // {GET, /v1/orders/:orderId, 404} мусить існувати ДО першого скрейпа.
    const warm = await get(MISSING_ID);
    const s0 = await scrape(pod.url);
    const missing = await Promise.all(Array.from({ length: DISTINCT_IDS }, (_, i) => get(MISSING_ID + 1 + i)));
    const s1 = await scrape(pod.url);
    const seriesBefore = seriesOf(s0);
    const seriesAfter = seriesOf(s1);
    console.log(`   прогрів ${warm.status}; ${DISTINCT_IDS} різних id → статуси ${[...new Set(missing.map((r) => r.status))].join(',')}`);
    summary.line('distinct-ids', DISTINCT_IDS);
    summary.line('series-before', seriesBefore);
    summary.line('series-after', seriesAfter);

    // ── RED ───────────────────────────────────────────────────────────────
    const replies = await Promise.all([
      ...Array.from({ length: FAST }, () => get(orderId)),
      ...Array.from({ length: SLOW }, () => get(orderId, 'slow')),
      ...Array.from({ length: FAILING }, () => get(orderId, 'error')),
    ]);
    const s2 = await scrape(pod.url);

    // Що відповів сервер, а не що ми замовляли: ok — усе нижче 500.
    const sentOk = replies.filter((r) => r.status < 500).length;
    const sentFail = replies.filter((r) => r.status >= 500).length;
    const counterDelta = sum(s2, 'http_requests_total', onRoute) - sum(s1, 'http_requests_total', onRoute);
    const errorsDelta =
      sum(s2, 'http_requests_total', (l) => onRoute(l) && l.status.startsWith('5')) -
      sum(s1, 'http_requests_total', (l) => onRoute(l) && l.status.startsWith('5'));
    // Скільки спостережень маршруту вилізло за верхній скінченний бакет — у +Inf.
    const count = sum(s2, 'http_request_duration_seconds_count', onRoute);
    const inTop = sum(s2, 'http_request_duration_seconds_bucket', (l) => onRoute(l) && Number(l.le) === TOP_LE);
    const aboveTop = count - inTop;
    const slowestMs = Math.round(Math.max(...replies.map((r) => r.ms)));

    console.log(`   статуси: ${[...new Set(replies.map((r) => r.status))].join(',')}; найповільніший ${slowestMs} мс; верхній le=${TOP_LE} с`);
    summary.line('sent-ok', sentOk);
    summary.line('sent-fail', sentFail);
    summary.line('counter-delta', counterDelta);
    summary.line('errors-delta', errorsDelta);
    summary.line('route-observations', count);
    summary.line('above-top-bucket', aboveTop);
    summary.line('slowest-ms', slowestMs);

    // ── Стенд: PromQL дашборда і сам дашборд ─────────────────────────────
    const prom = await checkPrometheus(sum(s2, 'process_start_time_seconds'));
    const panels = await grafanaPanels();
    if (prom !== undefined) {
      summary.line('prometheus-scraped-pod', prom.scraped ? 1 : 0);
      summary.line('dashboard-exprs-with-data', prom.withData);
    }
    if (panels !== undefined) summary.line('grafana-dashboard-panels', panels);

    summary.expect('sent-ok + sent-fail ≥ 50', sentOk + sentFail >= 50);
    summary.expect('counter-delta = sent-ok + sent-fail — порахований кожен запит', counterDelta === sentOk + sentFail);
    summary.expect('errors-delta = sent-fail — у лейбл status іде HTTP-код', errorsDelta === sentFail);
    summary.expect(`sent-fail = ${FAILING} — кожна замовлена відмова дала 5xx`, sentFail === FAILING);
    summary.expect('above-top-bucket=0 — найгірший запит нижче верхнього скінченного le', aboveTop === 0);
    summary.expect('series-after = series-before — сто id не додали жодного ряду', seriesAfter === seriesBefore);
    if (prom !== undefined) {
      summary.expect('prometheus-scraped-pod=1 — Prometheus скрейпить саме цей процес', prom.scraped);
      summary.expect(`dashboard-exprs-with-data=${prom.total} — кожна панель має ряд ${DEMO_ROUTE}`, prom.withData === prom.total);
    }
    if (panels !== undefined) summary.expect('Grafana віддає провіжений дашборд із 3 панелями', panels === 3);
  } finally {
    await pod?.stop();
    await cleanup(dataSource, DEMO).catch(() => undefined);
    await dataSource.destroy();
  }
  summary.finish();
}

const DASHBOARD = path.resolve('observability', 'grafana', 'dashboards', 'marketplace-red.json');

/** Усі `expr` з панелей дашборда — той самий файл, що провіжиться в Grafana. */
function dashboardExprs(): string[] {
  const json: unknown = JSON.parse(readFileSync(DASHBOARD, 'utf8'));
  const panels = typeof json === 'object' && json !== null ? Reflect.get(json, 'panels') : undefined;
  const exprs: string[] = [];
  for (const panel of Array.isArray(panels) ? panels : []) {
    const targets: unknown = typeof panel === 'object' && panel !== null ? Reflect.get(panel, 'targets') : undefined;
    for (const target of Array.isArray(targets) ? targets : []) {
      const expr: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, 'expr') : undefined;
      if (typeof expr === 'string') exprs.push(expr);
    }
  }
  return exprs;
}

const PROM_JOB = 'marketplace-demo';
/** rate() потрібні дві точки ряду, скрейп — кожні 2 с; із запасом на старт таргета. */
const PROM_WAIT_MS = 20_000;

interface PromSeries {
  labels: Record<string, string>;
  value: number;
}

/** Миттєвий запит до Prometheus; `undefined` — вираз не прийнято. */
async function promQuery(base: string, expr: string): Promise<PromSeries[] | undefined> {
  const reply = await request(`${base}/api/v1/query?query=${encodeURIComponent(expr)}`);
  const body = reply.json;
  const status = typeof body === 'object' && body !== null ? Reflect.get(body, 'status') : undefined;
  const data: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'data') : undefined;
  const result: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'result') : undefined;
  if (reply.status !== 200 || status !== 'success' || !Array.isArray(result)) return undefined;
  const series: PromSeries[] = [];
  for (const item of result) {
    if (typeof item !== 'object' || item === null) continue;
    const metric: unknown = Reflect.get(item, 'metric');
    const value: unknown = Reflect.get(item, 'value');
    if (!Array.isArray(value) || typeof value[1] !== 'string') continue;
    const labels: Record<string, string> = {};
    if (typeof metric === 'object' && metric !== null) {
      for (const [key, label] of Object.entries(metric)) if (typeof label === 'string') labels[key] = label;
    }
    series.push({ labels, value: Number(value[1]) });
  }
  return series;
}

async function poll(check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + PROM_WAIT_MS;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Дашборд проти Prometheus стенда — на даних ЦЬОГО пода. Без PROMETHEUS_URL
 * перевірки немає.
 *
 * `status: success` каже лише, що вираз розібрався. З таргетом у down усі
 * п'ять виразів відповідають success із порожнім результатом, і «валідний»
 * нічого не доводить. Тому два кроки:
 *   1. Prometheus скрейпить саме цей процес: `process_start_time_seconds` job
 *      `marketplace-demo` у Prometheus — те саме число, що в /metrics пода.
 *      Ні — друкуємо `up`, і таргет у down видно одразу.
 *   2. Кожен вираз панелі повертає ряд для DEMO_ROUTE. Ряд 500 народжується
 *      лише у фазі RED, а rate() потрібні дві його точки — тому опитування.
 *      Без кроку 1 вирази не питаємо зовсім: у них немає фільтра job, і
 *      вікно [1m] ще тримає точки попереднього прогону — панель «мала б дані»
 *      при таргеті в down.
 *
 * Значення не перевіряється. Ряд, що народився між двома скрейпами, Prometheus
 * рахує від першої точки, а не від нуля: rate може дати 0, а частка помилок і
 * квантилі — NaN. Перевіряється, що панелі є що малювати.
 */
async function checkPrometheus(podStartTime: number): Promise<{ scraped: boolean; withData: number; total: number } | undefined> {
  const raw = process.env.PROMETHEUS_URL;
  if (!raw) return undefined;
  const base = raw.replace(/\/+$/, '');
  const job = `{job="${PROM_JOB}"}`;

  const scraped = await poll(async () => (await promQuery(base, `process_start_time_seconds${job}`))?.some((s) => s.value === podStartTime) ?? false);
  const exprs = dashboardExprs();
  if (!scraped) {
    const up = await promQuery(base, `up${job}`);
    console.log(`   ✗ Prometheus не скрейпить под цього прогону: up${job} = ${up?.map((s) => s.value).join(',') || 'ряду немає'}`);
    console.log('   ✗ панелі не перевірено: дані в Prometheus не з цього прогону');
    return { scraped, withData: 0, total: exprs.length };
  }

  const hasRoute = async (expr: string): Promise<boolean> =>
    (await promQuery(base, expr))?.some((s) => s.labels.route === DEMO_ROUTE) ?? false;
  let withData = 0;
  for (const expr of exprs) {
    if (await poll(() => hasRoute(expr))) {
      withData += 1;
      continue;
    }
    const last = await promQuery(base, expr);
    console.log(`   ✗ ${last === undefined ? 'PromQL не прийнято' : `немає ряду ${DEMO_ROUTE}`}: ${expr}`);
  }
  return { scraped, withData, total: exprs.length };
}

/**
 * Провіжений дашборд — з API Grafana, логіном admin і паролем зі сховища
 * (GRAFANA_PASSWORD). Без GRAFANA_URL перевірки немає.
 */
async function grafanaPanels(): Promise<number | undefined> {
  const base = process.env.GRAFANA_URL;
  if (!base) return undefined;
  const password = process.env.GRAFANA_PASSWORD;
  const headers: Record<string, string> = password
    ? { authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` }
    : {};
  const url = `${base.replace(/\/+$/, '')}/api/dashboards/uid/marketplace-red`;
  let reply = await request(url, { headers });
  // Пароль не той (Grafana піднята голим `docker compose up` з дев-дефолтом,
  // а в сховищі згенерований) — дашборд однаково можна прочитати анонімно:
  // перевіряється провіження, а не пароль.
  if (reply.status === 401 && password) {
    console.log('   Grafana не прийняла GRAFANA_PASSWORD — читаю дашборд анонімно');
    reply = await request(url);
  }
  const dashboard = typeof reply.json === 'object' && reply.json !== null ? Reflect.get(reply.json, 'dashboard') : undefined;
  const panels: unknown = typeof dashboard === 'object' && dashboard !== null ? Reflect.get(dashboard, 'panels') : undefined;
  if (reply.status !== 200) console.log(`   ✗ Grafana відповіла ${reply.status}`);
  return Array.isArray(panels) ? panels.length : 0;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
