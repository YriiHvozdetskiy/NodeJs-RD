import 'reflect-metadata';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import { acquireLock, releaseLock } from './cache/cache-aside';
import { cardKey, CARD_CACHE, ProductCardsService } from './catalog/product-cards.service';
import { ProductsRepository, type ProductCard } from './catalog/products.repository';
import { cliDbConfig } from './db/cli-env';
import type { Queryable } from './db/queryable';
import { Summary } from './messaging/demo-kit';
import { configGet, keysWithPrefix, migrateSchema, openRedis } from './redis/demo-kit';
import { RedisConnections } from './redis/redis-connections';

/**
 * demo:cache — пункти 1 і 2 ДЗ #23 на справжньому ProductCardsService:
 *
 *   1. прогрів WARM карток → TTL з джитером: скільки різних TTL вийшло;
 *   2. ключ гарячої картки протух → CONCURRENT одночасних читань:
 *        наївний cache-aside (GET → промах → база → SET) — db-calls-no-lock;
 *        single-flight лок (ProductCardsService)          — db-calls;
 *   3. 100 читань теплої картки — db-calls-warm;
 *   4. чужий токен лок не знімає — foreign-unlock.
 *
 * db-calls рахується на межі з Postgres: репозиторію дано Queryable, який
 * рахує кожен SQL, що реально пішов у пул. Не «скільки разів викликали
 * функцію», а скільки запитів отримала база.
 *
 * «Поди» — PODS окремих зʼєднань із Redis, кожне зі своїм ProductCardsService:
 * лавина розкидана по них, як по інстансах API. Ключі — під префіксом цього
 * прогону; товари — свої, створені й видалені демо.
 */
const WARM = 60;
const CONCURRENT = 50;
const PODS = 5;
const WARM_READS = 100;

async function main(): Promise<void> {
  const summary = new Summary();
  const prefix = `demo-cache-${process.pid}-${Date.now().toString(36)}:`;
  const pool = new Pool({ ...cliDbConfig(), max: 10 });
  const admin = await openRedis('REDIS_CACHE_URL', 'demo-cache:admin');
  const pods: Redis[] = [];
  let productIds: number[] = [];

  try {
    await migrateSchema();

    // ── 0. налаштування кеш-інстансу — прочитані з живого зʼєднання ───────────
    const policy = await configGet(admin, 'maxmemory-policy');
    const maxmemory = Number(await configGet(admin, 'maxmemory'));
    console.log(`── demo:cache: кеш-інстанс maxmemory-policy ${policy}, maxmemory ${Math.round(maxmemory / 2 ** 20)} MiB ──`);

    productIds = await createProducts(pool, WARM);
    let dbCalls = 0;
    const counted: Queryable = {
      query: (text, values) => {
        dbCalls += 1;
        return pool.query(text, values);
      },
    };
    const repo = new ProductsRepository(counted);
    for (let i = 0; i < PODS; i++) {
      pods.push(await openRedis('REDIS_CACHE_URL', `demo-cache:pod-${i}`, { keyPrefix: prefix }));
    }
    const services = pods.map((redis) => new ProductCardsService(repo, new RedisConnections(redis, undefined)));

    // ── 1. прогрів і джитер ───────────────────────────────────────────────────
    const coldStarted = performance.now();
    for (const id of productIds) await services[0].get(id);
    const dbMs = (performance.now() - coldStarted) / productIds.length;
    const ttls = await Promise.all(productIds.map((id) => pods[0].ttl(cardKey(id))));
    const live = ttls.filter((ttl) => ttl > 0);
    console.log(`прогріто ${live.length} карток, TTL ${Math.min(...live)}…${Math.max(...live)} с (база ${CARD_CACHE.ttlSeconds} + random 0..${CARD_CACHE.ttlJitterSeconds})`);

    // ── 2. лавина на ключ, що щойно протух ────────────────────────────────────
    const hot = productIds[0];
    const expected = JSON.stringify(await services[0].get(hot));

    await expire(pods[0], cardKey(hot));
    dbCalls = 0;
    await Promise.all(Array.from({ length: CONCURRENT }, (_, i) => naiveGet(pods[i % PODS], repo, hot)));
    const dbCallsNoLock = dbCalls;
    console.log(`наївний cache-aside: ${CONCURRENT} одночасних промахів → ${dbCallsNoLock} походів у базу`);

    await expire(pods[0], cardKey(hot));
    dbCalls = 0;
    const answers = await Promise.all(Array.from({ length: CONCURRENT }, (_, i) => services[i % PODS].get(hot)));
    const dbCallsLocked = dbCalls;
    const sameAnswer = answers.every((card) => JSON.stringify(card) === expected);
    console.log(`single-flight лок: ${CONCURRENT} одночасних промахів → ${dbCallsLocked} похід у базу, решта дочекалась кешу`);

    // ── 3. теплий кеш ─────────────────────────────────────────────────────────
    dbCalls = 0;
    const warmStarted = performance.now();
    for (let i = 0; i < WARM_READS; i++) await services[i % PODS].get(hot);
    const cacheMs = (performance.now() - warmStarted) / WARM_READS;
    const dbCallsWarm = dbCalls;

    // ── 4. compare-and-delete: чужий токен лок не знімає ──────────────────────
    const lockKey = `lock:${cardKey(hot)}`;
    await acquireLock(pods[0], lockKey, 'token-pod-0', CARD_CACHE.lockTtlMs);
    const foreignUnlock = await releaseLock(pods[1], lockKey, 'token-pod-1');
    const ownUnlock = await releaseLock(pods[0], lockKey, 'token-pod-0');

    summary.line('cache-lru', policy !== 'noeviction' ? 1 : 0);
    summary.line('cache-maxmemory', maxmemory > 0 ? 1 : 0);
    summary.line('warmed', live.length);
    summary.line('ttl-distinct', new Set(live).size);
    summary.line('ttl-min', Math.min(...live));
    summary.line('ttl-max', Math.max(...live));
    summary.line('concurrent', CONCURRENT);
    summary.line('pods', PODS);
    summary.line('db-calls-no-lock', dbCallsNoLock);
    summary.line('db-calls', dbCallsLocked);
    summary.line('same-answer', sameAnswer ? 1 : 0);
    summary.line('warm-reads', WARM_READS);
    summary.line('db-calls-warm', dbCallsWarm);
    summary.line('db-ms', round(dbMs));
    summary.line('cache-ms', round(cacheMs));
    summary.line('foreign-unlock', foreignUnlock ? 1 : 0);
    summary.line('own-unlock', ownUnlock ? 1 : 0);

    summary.expect('cache-lru=1 — політика кеш-інстансу не noeviction', policy !== 'noeviction');
    summary.expect('cache-maxmemory=1 — у кеш-інстансу є стеля памʼяті', maxmemory > 0);
    summary.expect(`warmed=${WARM}`, live.length === WARM);
    summary.expect('ttl-distinct ≥ 5 — TTL із джитером', new Set(live).size >= 5);
    summary.expect('db-calls=1 — лавина дала один похід у базу', dbCallsLocked === 1);
    summary.expect('усі одночасні читання отримали ту саму картку', sameAnswer);
    summary.expect('db-calls-warm=0 — теплий кеш у базу не ходить', dbCallsWarm === 0);
    summary.expect('foreign-unlock=0 і own-unlock=1 — зняти можна лише свій лок', !foreignUnlock && ownUnlock);
  } finally {
    const leftovers = await keysWithPrefix(admin, prefix).catch(() => []);
    if (leftovers.length > 0) await admin.del(...leftovers);
    if (productIds.length > 0) await pool.query(`DELETE FROM products WHERE id = ANY($1::bigint[])`, [productIds]);
    await Promise.all([admin, ...pods].map((redis) => redis.quit().catch(() => undefined)));
    await pool.end();
  }
  summary.finish();
}

/**
 * Cache-aside без лока — точка відліку, а не код застосунку: саме так
 * виглядає «очевидна» реалізація. Усі одночасні промахи йдуть у базу.
 */
async function naiveGet(redis: Redis, repo: ProductsRepository, id: number): Promise<ProductCard | null> {
  const raw = await redis.get(cardKey(id));
  if (raw !== null) {
    const entry: { v: ProductCard | null } = JSON.parse(raw);
    return entry.v;
  }
  const card = await repo.findCard(id);
  await redis.set(cardKey(id), JSON.stringify({ v: card }), 'EX', CARD_CACHE.ttlSeconds);
  return card;
}

/**
 * Ключ «щойно протух»: PEXPIRE 1 — і чекаємо, доки Redis його прибере. Те саме,
 * що станеться з гарячою карткою, коли мине її TTL.
 */
async function expire(redis: Redis, key: string): Promise<void> {
  await redis.pexpire(key, 1);
  while ((await redis.exists(key)) === 1) await sleep(1);
}

/** Свої товари на кожен прогін: демо не залежить від сіду й не чіпає чужих карток. */
async function createProducts(pool: Pool, count: number): Promise<number[]> {
  const { rows: sellers } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role) VALUES ('cache-demo-seller@marketplace.local', '!', 'seller')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO products (seller_id, category, title, description, price_cents, stock)
     SELECT $1, 'electronics', 'demo:cache #' || g, 'Товар для demo:cache ДЗ #23', 100000 + g, 50
       FROM generate_series(1, $2::int) AS g
     RETURNING id`,
    [sellers[0].id, count],
  );
  return rows.map((row) => Number(row.id));
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
