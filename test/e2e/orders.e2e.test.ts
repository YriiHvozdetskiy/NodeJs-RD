import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { bootApp } from '../testkit/app';
import { loggedInUser, type LoggedIn } from '../testkit/auth';
import { anOrder, aProduct } from '../testkit/builders';
import { startPostgres, type TestPostgres } from '../testkit/postgres';

const PROBLEMS = 'https://api.marketplace.example/problems';

/**
 * Ізоляції через ROLLBACK тут немає і бути не може: застосунок бере з'єднання
 * зі своїх пулів, і транзакція тесту для нього не існує. Тому кожен тест
 * створює власний товар через builder, а база живе рівно стільки, скільки цей
 * файл, — контейнер зупиняється в afterAll.
 *
 * Покупець — справжній логін (testkit/auth.ts): замовлення оформлюються від
 * імені власника токена, і саме це тут теж перевіряється.
 */
describe('E2E · оформлення замовлення: повний Nest-застосунок + Postgres у testcontainers', () => {
  let pg: TestPostgres;
  let app: NestExpressApplication;
  let buyer: LoggedIn;

  beforeAll(async () => {
    pg = await startPostgres();
    app = await bootApp(pg);
    buyer = await loggedInUser(app, pg.pool);
  });

  afterAll(async () => {
    // Порядок важливий: спершу застосунок закриває свої пули, потім зникає база.
    // Навпаки — пули ловили б обрив з'єднань, а незакритий пул тримав би jest.
    await app?.close();
    await pg?.stop();
  });

  const stockOf = async (productId: number): Promise<number> =>
    (await pg.pool.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [productId])).rows[0].stock;

  test('happy path: POST /v1/orders → 201 від імені власника токена, GET /v1/orders/:id → 200 те саме замовлення, stock списано', async () => {
    const product = await aProduct().withPrice(125_000).withStock(5).insert(pg.pool);

    const created = await request(app.getHttpServer())
      .post('/v1/orders')
      .auth(buyer.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', `e2e-${randomUUID()}`)
      .send({ items: [{ product_id: product.id, qty: 2 }] })
      .expect(201);

    expect(created.headers.location).toBe(`/v1/orders/${created.body.id}`);
    expect(created.body).toEqual({
      id: expect.any(Number),
      items: [{ product_id: product.id, qty: 2, unit_price_cents: 125_000 }],
      total_cents: 250_000,
      currency: 'UAH',
      status: 'pending',
      created_at: expect.any(String),
    });

    const fetched = await request(app.getHttpServer())
      .get(`/v1/orders/${created.body.id}`)
      .auth(buyer.accessToken, { type: 'bearer' })
      .expect(200);

    expect(fetched.body).toEqual(created.body);
    expect(await stockOf(product.id)).toBe(3);
    const owner = await pg.pool.query<{ buyer_id: string }>('SELECT buyer_id FROM orders WHERE id = $1', [created.body.id]);
    expect(Number(owner.rows[0].buyer_id)).toBe(buyer.id);
  });

  test('неіснуюче замовлення → 404 problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/v1/orders/999999').auth(buyer.accessToken, { type: 'bearer' }).expect(404);

    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ type: `${PROBLEMS}/not-found`, status: 404, instance: '/v1/orders/999999' });
  });

  test('без токена → 401 unauthenticated і WWW-Authenticate: Bearer', async () => {
    const res = await request(app.getHttpServer()).get('/v1/orders/999999').expect(401);

    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
    expect(res.body).toMatchObject({ type: `${PROBLEMS}/unauthenticated`, status: 401 });
  });

  test('чуже замовлення → 403 forbidden, власнику те саме замовлення → 200', async () => {
    const owner = await loggedInUser(app, pg.pool);
    const order = await anOrder().byBuyer(owner.id).insert(pg.pool);

    const foreign = await request(app.getHttpServer())
      .get(`/v1/orders/${order.id}`)
      .auth(buyer.accessToken, { type: 'bearer' })
      .expect(403);
    expect(foreign.body).toMatchObject({ type: `${PROBLEMS}/forbidden`, status: 403 });

    await request(app.getHttpServer()).get(`/v1/orders/${order.id}`).auth(owner.accessToken, { type: 'bearer' }).expect(200);
  });

  test('порожній кошик → 400 від валідатора спеки, ще до контролера й до бази', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .auth(buyer.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', `e2e-${randomUUID()}`)
      .send({ items: [] })
      .expect(400);

    expect(res.body).toMatchObject({ type: `${PROBLEMS}/validation-error`, status: 400 });
    expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ pointer: '/body/items' })]));
  });

  test('залишку бракує → 409, і транзакція checkout відкотилась: stock той самий, замовлення немає', async () => {
    const product = await aProduct().withStock(1).insert(pg.pool);
    const ordersBefore = (await pg.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM orders')).rows[0].n;

    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .auth(buyer.accessToken, { type: 'bearer' })
      .set('Idempotency-Key', `e2e-${randomUUID()}`)
      .send({ items: [{ product_id: product.id, qty: 2 }] })
      .expect(409);

    expect(res.body).toMatchObject({ type: `${PROBLEMS}/conflict`, status: 409 });
    expect(await stockOf(product.id)).toBe(1);
    expect((await pg.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(ordersBefore);
  });
});
