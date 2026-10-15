import 'reflect-metadata';
import { Summary } from './messaging/demo-kit';
import { ORDERS_LIMIT, ORDERS_WINDOW_MS, ordersRateLimitKey } from './rate-limit/orders-rate-limit';
import { openRedis, PodProcess } from './redis/demo-kit';

/**
 * demo:ratelimit — пункт 4 ДЗ #23: два поди, один ліміт.
 *
 *   под A (процес ОС) ─┐
 *                      ├─ Lua sliding window ─ Redis черги (спільний)
 *   под B (процес ОС) ─┘
 *
 * ORDERS_LIMIT + 5 запитів POST /v1/orders летять ОДНОЧАСНО, по черзі в
 * під A і під B. Лічильник у памʼяті процесу пропустив би 2 × ліміт, а
 * неатомарний (ZCARD, потім ZADD) — «скільки встигло пролізти між ними».
 * Спільний атомарний — рівно ліміт.
 *
 * Тіло навмисно без позицій: пропущений лімітером запит далі відхиляє
 * валідатор спеки (400), тож демо не створює замовлень і нічого не лишає в
 * базі. Лімітеру байдуже, що буде після нього, — він стоїть першим.
 */
const PODS = 2;
const EXTRA = 5;

interface Shot {
  pod: number;
  status: number;
  retryAfter: string | null;
}

async function main(): Promise<void> {
  const summary = new Summary();
  const redis = await openRedis('REDIS_QUEUE_URL', 'demo-ratelimit');
  // Обидва поди слухають 127.0.0.1, демо приходить звідти ж — один клієнт.
  // Вікно від попередніх прогонів чи ручних запитів зіпсувало б рахунок.
  const keys = ['127.0.0.1', '::ffff:127.0.0.1', '::1'].map(ordersRateLimitKey);
  await redis.del(...keys);
  const pods: PodProcess[] = [];

  try {
    pods.push(...(await Promise.all(Array.from({ length: PODS }, (_, i) => PodProcess.start(`под ${i}`)))));
    console.log(`── demo:ratelimit: ${PODS} поди (pid ${pods.map((p) => p.pid).join(', ')}), ліміт ${ORDERS_LIMIT} за ${ORDERS_WINDOW_MS / 1000} с ──`);

    const requests = ORDERS_LIMIT + EXTRA;
    const shots: Shot[] = await Promise.all(
      Array.from({ length: requests }, async (_, i): Promise<Shot> => {
        const pod = i % PODS;
        const res = await fetch(`${pods[pod].url}/v1/orders`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': `demo-ratelimit-${i}-${Date.now()}` },
          body: '{}',
        });
        await res.body?.cancel();
        return { pod, status: res.status, retryAfter: res.headers.get('retry-after') };
      }),
    );

    const allowed = shots.filter((s) => s.status !== 429);
    const blocked = shots.filter((s) => s.status === 429);
    const last = blocked.at(-1);
    const retryAfter = last?.retryAfter ? Number(last.retryAfter) : NaN;
    for (let pod = 0; pod < PODS; pod++) {
      const mine = shots.filter((s) => s.pod === pod);
      console.log(`под ${pod}: пропустив ${mine.filter((s) => s.status !== 429).length}, відкинув ${mine.filter((s) => s.status === 429).length}`);
    }
    const allowedStatuses = [...new Set(allowed.map((s) => s.status))];

    summary.line('instances', pods.length);
    summary.line('limit', ORDERS_LIMIT);
    summary.line('requests', requests);
    summary.line('allowed', allowed.length);
    summary.line('blocked', blocked.length);
    summary.line('status', last?.status ?? 0);
    summary.line('retry-after', Number.isInteger(retryAfter) && retryAfter >= 1 ? 1 : 0);
    summary.line('retry-after-seconds', Number.isNaN(retryAfter) ? 0 : retryAfter);
    // 400 — валідатор спеки після лімітера, див. коментар угорі.
    summary.line('allowed-status', allowedStatuses.length === 1 ? allowedStatuses[0] : 0);

    summary.expect(`instances=${PODS}`, pods.length === PODS);
    summary.expect('allowed = limit — ліміт спільний для подів, а не на кожен', allowed.length === ORDERS_LIMIT);
    summary.expect(`blocked=${EXTRA}`, blocked.length === EXTRA);
    summary.expect('status=429 і цілий Retry-After ≥ 1', last?.status === 429 && Number.isInteger(retryAfter) && retryAfter >= 1);
  } finally {
    await Promise.all(pods.map((pod) => pod.stop()));
    await redis.del(...keys).catch(() => undefined);
    await redis.quit().catch(() => undefined);
  }
  summary.finish();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
