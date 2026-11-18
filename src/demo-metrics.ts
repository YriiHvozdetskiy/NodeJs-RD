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
    const exprsValid = await checkDashboardExprs();
    const panels = await grafanaPanels();
    if (exprsValid !== undefined) summary.line('dashboard-exprs-valid', exprsValid.valid);
    if (panels !== undefined) summary.line('grafana-dashboard-panels', panels);

    summary.expect('sent-ok + sent-fail ≥ 50', sentOk + sentFail >= 50);
    summary.expect('counter-delta = sent-ok + sent-fail — порахований кожен запит', counterDelta === sentOk + sentFail);
    summary.expect('errors-delta = sent-fail — у лейбл status іде HTTP-код', errorsDelta === sentFail);
    summary.expect(`sent-fail = ${FAILING} — кожна замовлена відмова дала 5xx`, sentFail === FAILING);
    summary.expect('above-top-bucket=0 — найгірший запит нижче верхнього скінченного le', aboveTop === 0);
    summary.expect('series-after = series-before — сто id не додали жодного ряду', seriesAfter === seriesBefore);
    if (exprsValid !== undefined) summary.expect('PromQL панелей дашборда валідний для Prometheus', exprsValid.valid === exprsValid.total);
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

/**
 * Кожен PromQL дашборда — у Prometheus стенда. `status: success` означає, що
 * вираз розібрався і виконався; порожній результат тут нормальний (демо живе
 * секунди). Без PROMETHEUS_URL перевірки немає.
 */
async function checkDashboardExprs(): Promise<{ valid: number; total: number } | undefined> {
  const base = process.env.PROMETHEUS_URL;
  if (!base) return undefined;
  const exprs = dashboardExprs();
  let valid = 0;
  for (const expr of exprs) {
    const reply = await request(`${base.replace(/\/+$/, '')}/api/v1/query?query=${encodeURIComponent(expr)}`);
    const status = typeof reply.json === 'object' && reply.json !== null ? Reflect.get(reply.json, 'status') : undefined;
    if (reply.status === 200 && status === 'success') valid += 1;
    else console.log(`   ✗ PromQL не прийнято (${reply.status}): ${expr}`);
  }
  return { valid, total: exprs.length };
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
