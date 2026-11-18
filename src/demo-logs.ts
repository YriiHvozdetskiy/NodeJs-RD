import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { cleanup } from './auth/demo-kit';
import { dataSourceOptions } from './data-source';
import { Summary } from './messaging/demo-kit';
import {
  buyerWithOrder,
  isAccessLine,
  loginAs,
  ObsPod,
  request,
  str,
  traceparent,
  type LogLine,
  type TraceParent,
} from './observability/demo-kit';
import { migrateSchema } from './redis/demo-kit';

/**
 * demo:logs (#29) — корелятор живе в контексті, а не в аргументах.
 *
 *   один запит GET /v1/orders/:id з traceparent
 *     → усі його рядки мають ОДИН trace_id, і це trace_id із заголовка;
 *     → рядків щонайменше з трьох шарів: контролер, сервіс, репозиторій;
 *   BURST паралельних однакових запитів, у кожного свій traceparent
 *     → груп за trace_id стільки ж, скільки запитів, і всі однакового розміру;
 *   запит із `Authorization: Bearer <маркер-1>` і логін із паролем <маркер-2>
 *     → рядки цих запитів у лозі є, маркерів у всьому stdout — нуль.
 *
 * Якби «поточний запит» лежав у змінній модуля, паралельні запити
 * перезаписували б його один одному: групи вийшли б різного розміру, а
 * частина рядків опинилась би під чужим trace_id.
 */
const DEMO = 'obs-logs';
const BURST = 12;

/** trace_id рядка або «none» — рядок, що загубив контекст, теж група, і вона видна. */
const traceOf = (line: LogLine): string => str(line, 'trace_id') ?? 'none';

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
    const orderUrl = `${pod.url}/v1/orders/${orderId}`;
    console.log(`── demo:logs: застосунок ${pod.url}, замовлення ${orderId} покупця ${buyer.id} ──`);

    const get = (tp: TraceParent) => request(orderUrl, { headers: { authorization: `Bearer ${token}`, traceparent: tp.header } });

    // Прогрів: перший запит маршруту будує кеші Nest і пулу. Його рядки — до
    // позначки, і в рахунок не йдуть.
    const warm = traceparent();
    await get(warm);
    await pod.waitForAccess([warm.traceId]);

    // ── 1. Один запит: один ключ на всі шари ─────────────────────────────
    const single = traceparent();
    const markSingle = pod.mark();
    const singleReply = await get(single);
    await pod.waitForAccess([single.traceId]);
    const singleLines = pod.since(markSingle);
    const singleIds = new Set(singleLines.map(traceOf));
    const layers = new Set(singleLines.map((line) => str(line, 'layer') ?? 'none'));
    const traceIdMatchesHeader = singleIds.size === 1 && singleIds.has(single.traceId) ? 1 : 0;
    // Найглибший шар не отримував ні req, ні userId — а userId у рядку є.
    const deepest = singleLines.find((line) => str(line, 'layer') === 'orders.repository');
    const deepestUser = deepest && str(deepest, 'userId') === buyer.id && traceOf(deepest) === single.traceId ? 1 : 0;

    console.log(`   один запит: ${singleReply.status}, рядків ${singleLines.length}, шари: ${[...layers].join(', ')}`);
    summary.line('lines-per-request', singleLines.length);
    summary.line('layers', layers.size);
    summary.line('distinct-trace-ids', singleIds.size);
    summary.line('trace-id-matches-header', traceIdMatchesHeader);
    summary.line('deepest-layer-has-user', deepestUser);

    // ── 2. Burst: паралельні запити не змішуються ────────────────────────
    const burst = Array.from({ length: BURST }, () => traceparent());
    const markBurst = pod.mark();
    const burstReplies = await Promise.all(burst.map(get));
    await pod.waitForAccess(burst.map((tp) => tp.traceId));
    const groups = new Map<string, number>();
    for (const line of pod.since(markBurst)) groups.set(traceOf(line), (groups.get(traceOf(line)) ?? 0) + 1);
    const sent = new Set(burst.map((tp) => tp.traceId));
    // Нерівна група — або розмір не той, що в одиночного запиту, або trace_id,
    // якого ми не надсилали (рядок загубив контекст чи взяв чужий).
    const uneven = [...groups].filter(([id, size]) => size !== singleLines.length || !sent.has(id)).length;

    console.log(`   burst: статуси ${[...new Set(burstReplies.map((r) => r.status))].join(',')}, групи: ${[...groups.values()].join(' ')}`);
    summary.line('burst', burst.length);
    summary.line('burst-trace-ids', groups.size);
    summary.line('burst-uneven', uneven);

    // ── 3. Секрети не течуть ─────────────────────────────────────────────
    const tokenMarker = `tok${randomBytes(12).toString('hex')}`;
    const passwordMarker = `pw${randomBytes(12).toString('hex')}`;
    const withToken = traceparent();
    const withPassword = traceparent();
    const tokenReply = await request(orderUrl, {
      headers: { authorization: `Bearer ${tokenMarker}`, traceparent: withToken.header },
    });
    const loginReply = await request(`${pod.url}/v1/auth/login`, {
      method: 'POST',
      headers: { traceparent: withPassword.header },
      body: { email: buyer.email, password: passwordMarker },
    });
    await pod.waitForAccess([withToken.traceId, withPassword.traceId]);
    console.log(`   секрети: токен-маркер → ${tokenReply.status}, пароль-маркер → ${loginReply.status}`);

    await pod.stop();

    // Увесь stdout застосунку — від першого рядка Nest до виходу.
    const accessIds = new Set(pod.lines.filter(isAccessLine).map(traceOf));
    const secretReqLogged = accessIds.has(withToken.traceId) && accessIds.has(withPassword.traceId) ? 1 : 0;
    const secretInLogs = pod.lines.filter((line) => line.raw.includes(tokenMarker) || line.raw.includes(passwordMarker)).length;
    const nonJson = pod.lines.filter((line) => line.json === null).length;
    const redactedPassword = pod.lines.some((line) => str(line, 'trace_id') === withPassword.traceId && line.raw.includes('"password":"[REDACTED]"'))
      ? 1
      : 0;

    summary.line('secret-req-logged', secretReqLogged);
    summary.line('secret-in-logs', secretInLogs);
    summary.line('password-redacted-in-line', redactedPassword);
    summary.line('stdout-lines', pod.lines.length);
    summary.line('non-json-lines', nonJson);

    summary.expect('layers ≥ 3 — контролер, сервіс і репозиторій пишуть у лог', layers.size >= 3);
    summary.expect('distinct-trace-ids=1 — усі рядки запиту під одним ключем', singleIds.size === 1);
    summary.expect('trace-id-matches-header=1 — ключ узято з traceparent, а не згенеровано', traceIdMatchesHeader === 1);
    summary.expect('deepest-layer-has-user=1 — userId дійшов до репозиторію з контексту', deepestUser === 1);
    summary.expect(`burst=${BURST} ≥ 8`, burst.length >= 8);
    summary.expect('burst-trace-ids = burst — кожен запит своя група', groups.size === burst.length);
    summary.expect('burst-uneven=0 — групи однакового розміру, рядки не змішались', uneven === 0);
    summary.expect('secret-req-logged=1 — рядки запитів із секретами в лозі є', secretReqLogged === 1);
    summary.expect('secret-in-logs=0 — маркерів токена й пароля в лозі немає', secretInLogs === 0);
    summary.expect('non-json-lines=0 — кожен рядок stdout застосунку — JSON', nonJson === 0);
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
