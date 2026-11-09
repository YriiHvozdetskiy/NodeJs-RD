import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { call, cleanup, createUser, detailOf, login, tokensOf, type Reply } from './auth/demo-kit';
import { Summary } from './messaging/demo-kit';
import { migrateSchema, startApi, type Api } from './redis/demo-kit';

/**
 * demo:reuse — ⭐ пункт 3 ДЗ #24: повторне використання refresh валить усю сімʼю.
 *
 *   login ──► R1                              сімʼя F
 *   refresh R1 ──► A2 + R2         → 200      R1.used_at = now
 *   refresh R1 ЗНОВУ               → 401      R1 уже used → компрометація: revoked_at на всю F
 *   refresh R2                     → 401      ← головний рядок
 *
 * r1-reuse=401 уміє й ротація без сімʼї: «старий токен більше не працює». А
 * r2-after-reuse=401 означає, що після сигналу компрометації вилетів і той, хто
 * тримав R2. Сервер не знає, хто з двох власників R1 — злодій, тож відкликає
 * обох; у реальному житті R1 предʼявив би злодій, а R2 тримав би чесний клієнт
 * (або навпаки — і саме тому обидва).
 */
const DEMO = 'reuse';

async function main(): Promise<void> {
  const summary = new Summary();
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  let api: Api | undefined;

  try {
    await migrateSchema();
    await cleanup(dataSource, DEMO);
    const buyer = await createUser(dataSource, DEMO, 'buyer', 'buyer');
    const app = await startApi();
    api = app;
    console.log(`── demo:reuse: покупець ${buyer.email}, застосунок на ${app.url} ──`);

    const step = (key: string, reply: Reply): number => {
      summary.line(key, reply.status);
      const detail = detailOf(reply);
      if (detail) console.log(`   ${key}: ${detail}`);
      return reply.status;
    };
    const refresh = (token: string): Promise<Reply> => call(app, 'POST', '/auth/refresh', { body: { refresh_token: token } });

    const loggedIn = await login(app, buyer);
    const r1 = tokensOf(loggedIn).refresh;
    const statusLogin = step('login', loggedIn);

    const rotated = await refresh(r1);
    const { access: a2, refresh: r2 } = tokensOf(rotated);
    const statusR1 = step('r1-refresh', rotated);

    const statusReuse = step('r1-reuse', await refresh(r1));
    const statusR2 = step('r2-after-reuse', await refresh(r2));
    // Понад контракт: access-токен, виданий разом із R2, теж уже мертвий —
    // детекція повтору поклала всю сімʼю в денилист, а не лише в базу.
    const statusA2 = step('a2-after-reuse', await call(app, 'GET', '/auth/me', { token: a2 }));

    const family: { total: string; live: string; used: string }[] = await dataSource.query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE revoked_at IS NULL) AS live,
              count(*) FILTER (WHERE used_at IS NOT NULL) AS used
         FROM refresh_tokens WHERE user_id = $1`,
      [buyer.id],
    );
    const total = Number(family[0].total);
    const live = Number(family[0].live);
    summary.line('family-tokens', total);
    summary.line('family-live', live);

    summary.expect('login=200', statusLogin === 200);
    summary.expect('r1-refresh=200', statusR1 === 200);
    summary.expect('r1-reuse=401 — використаний токен вдруге не працює', statusReuse === 401);
    summary.expect('r2-after-reuse=401 — повтор відкликав усю сімʼю, а не лише R1', statusR2 === 401);
    summary.expect('a2-after-reuse=401 — і access-токен цієї сімʼї теж', statusA2 === 401);
    summary.expect('family-tokens=2 — повтор не виписав нової пари', total === 2);
    summary.expect('family-live=0 — у сімʼї не лишилось жодного живого refresh', live === 0);
  } finally {
    await api?.close();
    await cleanup(dataSource, DEMO).catch(() => undefined);
    await dataSource.destroy();
  }
  summary.finish();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
