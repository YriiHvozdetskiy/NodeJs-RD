import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AccessDenylist } from '../../src/auth/access-denylist';
import { bootApp } from '../testkit/app';
import { loggedInUser, MemoryDenylist } from '../testkit/auth';
import { startPostgres, type TestPostgres } from '../testkit/postgres';

/**
 * Детекція повтору, коли денилист недоступний (після ревʼю #24).
 *
 * Повтор refresh-токена відкликає сімʼю в Postgres і пише її в денилист.
 * Якщо запис у денилист не дійшов, клієнт має отримати 503, а не 401: 401
 * закрив би розмову, і access-токен злодія жив би до exp. Повтор того самого
 * запиту приходить у гілку «сесію вже відкликано», і та дописує сімʼю —
 * тоді вже 401, і access-токен сімʼї мертвий.
 */
describe('E2E · повтор refresh-токена при недоступному денилисті', () => {
  let pg: TestPostgres;
  let app: NestExpressApplication;
  let denylist: MemoryDenylist;

  beforeAll(async () => {
    pg = await startPostgres();
    app = await bootApp(pg);
    const provided = app.get(AccessDenylist);
    if (!(provided instanceof MemoryDenylist)) throw new Error('bootApp мав підмінити AccessDenylist на MemoryDenylist');
    denylist = provided;
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  afterEach(() => {
    denylist.writesFail = false;
  });

  test('повтор → 503, поки запис не доходить; повтор того самого токена після відновлення → 401, access сімʼї мертвий', async () => {
    const http = request(app.getHttpServer());
    const user = await loggedInUser(app, pg.pool);

    const rotated = await http.post('/v1/auth/refresh').send({ refresh_token: user.refreshToken }).expect(200);
    const access = rotated.body.access_token;

    denylist.writesFail = true;
    const reuse = await http.post('/v1/auth/refresh').send({ refresh_token: user.refreshToken });
    expect(reuse.status).toBe(503);
    // Дірка, яку закриває повтор: сімʼя в базі вже мертва, а access ще проходить.
    await http.get('/v1/auth/me').set('authorization', `Bearer ${access}`).expect(200);
    const live = await pg.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id],
    );
    expect(live.rows[0].n).toBe(0);

    denylist.writesFail = false;
    await http.post('/v1/auth/refresh').send({ refresh_token: user.refreshToken }).expect(401);
    await http.get('/v1/auth/me').set('authorization', `Bearer ${access}`).expect(401);
  });

  test('давно відкликана сімʼя: повтор не пише в денилист і не впирається в його недоступність — 401', async () => {
    const http = request(app.getHttpServer());
    const user = await loggedInUser(app, pg.pool);
    await http.post('/v1/auth/logout').set('authorization', `Bearer ${user.accessToken}`).expect(204);
    // Відкликано більше ніж ACCESS_TTL тому — живих access-токенів сімʼї вже немає.
    await pg.pool.query(`UPDATE refresh_tokens SET revoked_at = now() - interval '1 hour' WHERE user_id = $1`, [user.id]);

    denylist.writesFail = true;
    await http.post('/v1/auth/refresh').send({ refresh_token: user.refreshToken }).expect(401);
  });
});
