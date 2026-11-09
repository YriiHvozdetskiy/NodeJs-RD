import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { ACCESS_TTL_SECONDS } from './auth/access-tokens';
import { familyKey, jtiKey } from './auth/access-denylist';
import { call, claimsOf, cleanup, createUser, detailOf, login, tokensOf, type Reply } from './auth/demo-kit';
import { Summary } from './messaging/demo-kit';
import { migrateSchema, openRedis, startApi, type Api } from './redis/demo-kit';

/**
 * demo:resync — після ревʼю #24: денилист — похідна від Postgres, і втрачений
 * запис повертається сам.
 *
 * Логаут і детекція повтору пишуть у два сховища: revoked_at у Postgres
 * комітиться першим, запис у Redis — другим. Якщо другий не дійшов (Redis
 * лежав), access-токени відкликаної сімʼї знову проходять гард. Демо робить
 * рівно цей стан і дивиться, як його лагодить resync:
 *
 *   сімʼя A: login → refresh R1 → повтор R1          → 401, revoked_at + fid у Redis
 *   сімʼя B: login → logout                          → 204, revoked_at + jti + fid у Redis
 *   DEL записів обох сімей у Redis                   ← «запис не дійшов»
 *   access A, access B                               → 200 · 200   дірка справжня
 *   CLIENT KILL зʼєднання застосунку з Redis черги   → реконект → ready → resync
 *   access A, access B                               → 401 · 401   записи відновлено з revoked_at
 *
 * CLIENT KILL рве всі зʼєднання з імʼям marketplace-api:queue, тобто й
 * запущеного поруч `npm run start:vault` чи подів `demo:ratelimit`. Для них це
 * звичайний реконект: вони зроблять той самий resync.
 */
const DEMO = 'resync';
const RESTORE_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const summary = new Summary();
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const redis = await openRedis('REDIS_QUEUE_URL', 'demo-resync');
  let api: Api | undefined;

  try {
    await migrateSchema();
    await cleanup(dataSource, DEMO);
    const [reused, loggedOut] = await Promise.all([
      createUser(dataSource, DEMO, 'reused', 'buyer'),
      createUser(dataSource, DEMO, 'loggedout', 'buyer'),
    ]);
    const app = await startApi();
    api = app;
    console.log(`── demo:resync: застосунок на ${app.url} ──`);

    const step = (key: string, reply: Reply): number => {
      summary.line(key, reply.status);
      const detail = detailOf(reply);
      if (detail) console.log(`   ${key}: ${detail}`);
      return reply.status;
    };
    const me = (token: string): Promise<Reply> => call(app, 'GET', '/auth/me', { token });

    // Сімʼя A: повтор refresh-токена.
    const r1 = tokensOf(await login(app, reused)).refresh;
    const a = tokensOf(await call(app, 'POST', '/auth/refresh', { body: { refresh_token: r1 } }));
    const statusReuse = step('reuse', await call(app, 'POST', '/auth/refresh', { body: { refresh_token: r1 } }));

    // Сімʼя B: логаут.
    const b = tokensOf(await login(app, loggedOut));
    const statusLogout = step('logout', await call(app, 'POST', '/auth/logout', { token: b.access }));

    // «Запис до Redis не дійшов»: прибираємо все, що денилист знає про обидві сімʼї.
    const claimsA = claimsOf(a.access);
    const claimsB = claimsOf(b.access);
    const keys = [familyKey(claimsA.fid), jtiKey(claimsA.jti), familyKey(claimsB.fid), jtiKey(claimsB.jti)];
    await redis.del(...keys);
    const statusLostA = step('reuse-access-lost-write', await me(a.access));
    const statusLostB = step('logout-access-lost-write', await me(b.access));

    // Реконект застосунку до Redis черги — той самий `ready`, що після падіння Redis.
    const killed = await killAppConnections(redis);
    const restored = await until(
      async () => (await redis.exists(familyKey(claimsA.fid), familyKey(claimsB.fid))) === 2,
      RESTORE_TIMEOUT_MS,
    );
    const statusAfterA = step('reuse-access-after-resync', await me(a.access));
    const statusAfterB = step('logout-access-after-resync', await me(b.access));
    const ttls = await Promise.all([redis.ttl(familyKey(claimsA.fid)), redis.ttl(familyKey(claimsB.fid))]);
    const ttlBounded = ttls.every((ttl) => ttl > 0 && ttl <= ACCESS_TTL_SECONDS) ? 1 : 0;

    summary.line('connections-killed', killed > 0 ? 1 : 0);
    summary.line('fid-restored', restored ? 1 : 0);
    summary.line('fid-ttl-bounded', ttlBounded);

    summary.expect('reuse=401', statusReuse === 401);
    summary.expect('logout=204', statusLogout === 204);
    summary.expect('*-lost-write=200 — без запису в Redis відкликані токени справді проходять', statusLostA === 200 && statusLostB === 200);
    summary.expect('connections-killed=1', killed > 0);
    summary.expect('fid-restored=1 — resync повернув записи обох сімей із revoked_at', restored);
    summary.expect('*-after-resync=401', statusAfterA === 401 && statusAfterB === 401);
    summary.expect('fid-ttl-bounded=1 — запис не переживає останній access-токен сімʼї', ttlBounded === 1);
  } finally {
    await api?.close();
    await cleanup(dataSource, DEMO).catch(() => undefined);
    await dataSource.destroy();
    await redis.quit().catch(() => undefined);
  }
  summary.finish();
}

/** CLIENT KILL кожного зʼєднання застосунку з Redis черги (імʼя з src/redis/redis-connections.ts). */
async function killAppConnections(redis: Awaited<ReturnType<typeof openRedis>>): Promise<number> {
  const list = String(await redis.client('LIST'));
  const ids = list
    .split('\n')
    .filter((line) => / name=marketplace-api:queue( |$)/.test(line))
    .map((line) => /^id=(\d+)/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
  for (const id of ids) await redis.client('KILL', 'ID', id);
  return ids.length;
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
