import { UsersRepository } from '../../src/users/users.repository';
import { aUser } from '../testkit/builders';
import { rollbackEachTest } from '../testkit/isolation';
import { startPostgres, type TestPostgres } from '../testkit/postgres';

describe('UsersRepository · Postgres 16 у testcontainers', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const db = rollbackEachTest(() => pg.pool);

  test('ensureBuyer створює покупця з роллю buyer і забороненим входом', async () => {
    const id = await new UsersRepository(db()).ensureBuyer('guest@test.local');

    const { rows } = await db().query('SELECT role, password_hash FROM users WHERE id = $1', [id]);
    expect(rows).toEqual([{ role: 'buyer', password_hash: '!' }]);
  });

  test('ON CONFLICT: повторний ensureBuyer повертає той самий id і не створює дубль', async () => {
    const repo = new UsersRepository(db());

    const first = await repo.ensureBuyer('twice@test.local');
    const second = await repo.ensureBuyer('twice@test.local');

    expect(second).toBe(first);
    const { rows } = await db().query('SELECT count(*)::int AS n FROM users WHERE email = $1', ['twice@test.local']);
    expect(rows[0].n).toBe(1);
  });

  test('ensureBuyer на email наявного користувача віддає його id, а не новий рядок', async () => {
    const existing = await aUser().insert(db());

    const id = await new UsersRepository(db()).ensureBuyer(existing.email);

    expect(id).toBe(String(existing.id));
  });

  test('UNIQUE (email): звичайний INSERT того самого email падає з 23505 — на цьому constraint і стоїть ON CONFLICT', async () => {
    const existing = await aUser().insert(db());

    await expect(aUser().withEmail(existing.email).insert(db())).rejects.toMatchObject({
      code: '23505',
      constraint: 'users_email_key',
    });
  });
});
