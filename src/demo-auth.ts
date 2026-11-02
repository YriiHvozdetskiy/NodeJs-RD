import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { ACCESS_TTL_SECONDS } from './auth/access-tokens';
import { familyKey, jtiKey } from './auth/access-denylist';
import { call, claimsOf, cleanup, createUser, detailOf, login, tokensOf, type Reply } from './auth/demo-kit';
import { Summary } from './messaging/demo-kit';
import { migrateSchema, openRedis, startApi, type Api } from './redis/demo-kit';

/**
 * demo:auth — пункт 4 ДЗ #24: логаут прибиває І refresh, І access.
 *
 *   login ──► A1 + R1
 *   GET /auth/me без токена            → 401
 *   GET /auth/me з A1                  → 200
 *   refresh R1 ──► A2 + R2             → 200
 *   logout з A2                        → 204   revoked_at на сімʼю + jti A2 у денилист
 *   GET /auth/me з A2                  → 401   ← денилист: без нього A2 жив би до exp
 *   refresh R2                         → 401   ← revoked_at: рядок у базі позначено
 *
 * Дві останні перевірки — два різні механізми, і саме тому їх дві: refresh —
 * рядок у базі, його досить позначити; access самодостатній і живе до exp,
 * тож для нього потрібен денилист.
 */
const DEMO = 'auth';

async function main(): Promise<void> {
  const summary = new Summary();
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const redis = await openRedis('REDIS_QUEUE_URL', 'demo-auth');
  let api: Api | undefined;

  try {
    await migrateSchema();
    await cleanup(dataSource, DEMO);
    const buyer = await createUser(dataSource, DEMO, 'buyer', 'buyer');
    api = await startApi();
    console.log(`── demo:auth: покупець ${buyer.email}, застосунок на ${api.url} ──`);

    const step = (key: string, reply: Reply): number => {
      summary.line(key, reply.status);
      const detail = detailOf(reply);
      if (detail) console.log(`   ${key}: ${detail}`);
      return reply.status;
    };

    const loggedIn = await login(api, buyer);
    const first = tokensOf(loggedIn);
    const statusLogin = step('login', loggedIn);
    const statusNoToken = step('no-token', await call(api, 'GET', '/auth/me'));
    const statusWithToken = step('with-token', await call(api, 'GET', '/auth/me', { token: first.access }));

    const refreshed = await call(api, 'POST', '/auth/refresh', { body: { refresh_token: first.refresh } });
    const second = tokensOf(refreshed);
    const statusRefresh = step('refresh', refreshed);

    const statusLogout = step('logout', await call(api, 'POST', '/auth/logout', { token: second.access }));
    const statusAfter = step('after-logout', await call(api, 'GET', '/auth/me', { token: second.access }));
    const statusRefreshAfter = step(
      'refresh-after-logout',
      await call(api, 'POST', '/auth/refresh', { body: { refresh_token: second.refresh } }),
    );
    // Понад контракт: A1 виписаний ДО логауту попереднім кроком сімʼї, і його jti
    // логаут не бачив. Закриває його запис сімʼї в денилисті.
    const statusFirstAfter = step('first-access-after-logout', await call(api, 'GET', '/auth/me', { token: first.access }));

    // Стан, який залишив логаут: обидва refresh-токени сімʼї позначені в базі,
    // а записи денилиста мають TTL не довший за життя access-токена.
    const family: { total: string; revoked: string }[] = await dataSource.query(
      `SELECT count(*) AS total, count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked
         FROM refresh_tokens WHERE user_id = $1`,
      [buyer.id],
    );
    const revokedRows = Number(family[0].revoked);
    const { jti, fid } = claimsOf(second.access);
    const ttls = await Promise.all([redis.ttl(jtiKey(jti)), redis.ttl(familyKey(fid))]);
    const ttlBounded = ttls.every((ttl) => ttl > 0 && ttl <= ACCESS_TTL_SECONDS) ? 1 : 0;
    summary.line('refresh-rows-revoked', revokedRows);
    summary.line('denylist-ttl-bounded', ttlBounded);

    summary.expect('login=200', statusLogin === 200);
    summary.expect('no-token=401', statusNoToken === 401);
    summary.expect('with-token=200', statusWithToken === 200);
    summary.expect('refresh=200', statusRefresh === 200);
    summary.expect('logout=204', statusLogout === 204);
    summary.expect('after-logout=401 — access відкликано денилистом до свого exp', statusAfter === 401);
    summary.expect('refresh-after-logout=401 — сімʼю refresh-токенів позначено revoked_at', statusRefreshAfter === 401);
    summary.expect('first-access-after-logout=401 — відкликано всю сімʼю, а не лише предʼявлений jti', statusFirstAfter === 401);
    summary.expect('refresh-rows-revoked=2 — R1 і R2', revokedRows === 2);
    summary.expect('denylist-ttl-bounded=1 — записи денилиста зникають самі, не пізніше за exp', ttlBounded === 1);
  } finally {
    await api?.close();
    await cleanup(dataSource, DEMO).catch(() => undefined);
    await dataSource.destroy();
    await redis.quit().catch(() => undefined);
  }
  summary.finish();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
