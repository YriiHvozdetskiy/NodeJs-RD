import 'reflect-metadata';
import { setTimeout as sleep } from 'node:timers/promises';
import { Summary } from './messaging/demo-kit';
import { migrateSchema, openRedis, startApi, type Api } from './redis/demo-kit';
import { sessionKey } from './sessions/session-store';
import { SESSION_COOKIE } from './sessions/sessions.service';

/**
 * demo:session — пункт 3 ДЗ #23 через справжній HTTP:
 *
 *   POST /v1/sessions                → Set-Cookie: sid=…; ключ у Redis черги
 *   пауза PAUSE_MS → TTL зменшився
 *   GET  /v1/sessions/current        → TTL знову повний (GETEX у middleware)
 *   пауза PAUSE_MS → TTL зменшився
 *   GET  /v1/products?limit=1        → теж подовжив: сесію читає кожен запит
 *   застосунок закрито й піднято заново (нові зʼєднання, порожня памʼять)
 *   GET  /v1/sessions/current        → та сама сесія: стан у Redis, не в процесі
 *   DELETE /v1/sessions/current      → ключа в Redis немає
 *   GET  /v1/sessions/current        → 401: старий cookie більше нічого не відкриває
 *
 * TTL читається напряму з Redis (PTTL, мс): саме там, а не у відповіді API,
 * видно, що сесію подовжено.
 */
const PAUSE_MS = 1_500;

interface Reply {
  status: number;
  body: unknown;
}

async function main(): Promise<void> {
  const summary = new Summary();
  await migrateSchema();
  const redis = await openRedis('REDIS_QUEUE_URL', 'demo-session');
  let api: Api | undefined = await startApi();
  const sids = new Set<string>();
  let cookie = '';
  let requests = 0;
  let key: string | undefined;

  const call = async (method: string, path: string): Promise<Reply> => {
    if (!api) throw new Error('застосунок не запущений');
    const res = await fetch(`${api.url}/v1${path}`, { method, headers: cookie ? { cookie } : {} });
    requests += 1;
    // Кожен sid, що сервер колись видав. Сесія одна — значить, сервер жодного
    // разу не відкрив нову замість того, щоб знайти стару.
    for (const header of res.headers.getSetCookie()) {
      const sid = new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(header)?.[1];
      if (sid) {
        sids.add(sid);
        cookie = `${SESSION_COOKIE}=${sid}`;
      }
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  try {
    console.log('── demo:session: cookie → Redis → rolling TTL → рестарт → відкликання ──');
    const created = await call('POST', '/sessions');
    const sid = [...sids][0];
    if (created.status !== 201 || !sid) throw new Error(`POST /v1/sessions → ${created.status}: ${JSON.stringify(created.body)}`);
    key = sessionKey(sid);
    const ttlCreated = await redis.pttl(key);

    // 1. Подовження запитом до самої сесії.
    await sleep(PAUSE_MS);
    const before1 = await redis.pttl(key);
    const current = await call('GET', '/sessions/current');
    const after1 = await redis.pttl(key);
    console.log(`PTTL ${before1} мс → GET /v1/sessions/current → ${after1} мс`);

    // 2. Подовження запитом до будь-якого іншого маршруту.
    await sleep(PAUSE_MS);
    const before2 = await redis.pttl(key);
    const products = await call('GET', '/products?limit=1');
    const after2 = await redis.pttl(key);
    console.log(`PTTL ${before2} мс → GET /v1/products → ${after2} мс`);

    // 3. Рестарт застосунку: нові зʼєднання, жодного стану в памʼяті.
    await api.close();
    api = undefined;
    api = await startApi();
    const afterRestart = await call('GET', '/sessions/current');
    const survived = afterRestart.status === 200 && createdAt(afterRestart.body) === createdAt(created.body);
    const inRedis = (await redis.exists(key)) === 1;

    // 4. Відкликання.
    const deleted = await call('DELETE', '/sessions/current');
    const gone = (await redis.exists(key)) === 0;
    const afterDelete = await call('GET', '/sessions/current');

    const renewed = after1 > before1 && after2 > before2;
    summary.line('requests', requests);
    summary.line('sessions', sids.size);
    summary.line('in-redis', inRedis ? 1 : 0);
    summary.line('ttl-renewed', renewed ? 1 : 0);
    summary.line('ttl-created-ms', ttlCreated);
    summary.line('ttl-before-ms', before1);
    summary.line('ttl-after-ms', after1);
    summary.line('survived-restart', survived ? 1 : 0);
    summary.line('revoked', gone ? 1 : 0);
    summary.line('status-after-revoke', afterDelete.status);

    summary.expect('POST 201, GET 200, products 200', created.status === 201 && current.status === 200 && products.status === 200);
    summary.expect('sessions=1 — усі запити ходили з однією сесією', sids.size === 1);
    summary.expect('in-redis=1 — ключ сесії лежить у Redis', inRedis);
    summary.expect('ttl-renewed=1 — активність подовжила TTL (обидва рази)', renewed);
    summary.expect('сесія пережила рестарт застосунку', survived);
    summary.expect('DELETE 204, ключ зник, старий cookie → 401', deleted.status === 204 && gone && afterDelete.status === 401);
  } finally {
    // Демо впало посередині — сесію прибираємо самі.
    if (key) await redis.del(key).catch(() => undefined);
    await api?.close();
    await redis.quit().catch(() => undefined);
  }
  summary.finish();
}

function createdAt(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'created_at' in body && typeof body.created_at === 'string') {
    return body.created_at;
  }
  return undefined;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
