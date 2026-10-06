import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { bootApp } from '../testkit/app';
import { aProduct } from '../testkit/builders';
import { startPostgres, type TestPostgres } from '../testkit/postgres';

const PROBLEMS = 'https://api.marketplace.example/problems';

/**
 * Ізоляції через ROLLBACK тут немає і бути не може: застосунок бере з'єднання
 * зі своїх пулів, і транзакція тесту для нього не існує. Тому кожен тест
 * створює власний товар через builder, а база живе рівно стільки, скільки цей
 * файл, — контейнер зупиняється в afterAll.
 */
describe('E2E · оформлення замовлення: повний Nest-застосунок + Postgres у testcontainers', () => {
  let pg: TestPostgres;
  let app: NestExpressApplication;

  beforeAll(async () => {
    pg = await startPostgres();
    app = await bootApp(pg);
  });

  afterAll(async () => {
    // Порядок важливий: спершу застосунок закриває свої пули, потім зникає база.
    // Навпаки — пули ловили б обрив з'єднань, а незакритий пул тримав би jest.
    await app?.close();
    await pg?.stop();
  });

  const stockOf = async (productId: number): Promise<number> =>
    (await pg.pool.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [productId])).rows[0].stock;

  test('happy path: POST /v1/orders → 201, GET /v1/orders/:id → 200 те саме замовлення, stock списано', async () => {
    const product = await aProduct().withPrice(125_000).withStock(5).insert(pg.pool);

    const created = await request(app.getHttpServer())
      .post('/v1/orders')
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

    const fetched = await request(app.getHttpServer()).get(`/v1/orders/${created.body.id}`).expect(200);

    expect(fetched.body).toEqual(created.body);
    expect(await stockOf(product.id)).toBe(3);
  });

  test('неіснуюче замовлення → 404 problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/v1/orders/999999').expect(404);

    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ type: `${PROBLEMS}/not-found`, status: 404, instance: '/v1/orders/999999' });
  });

  test('порожній кошик → 400 від валідатора спеки, ще до контролера й до бази', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
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
      .set('Idempotency-Key', `e2e-${randomUUID()}`)
      .send({ items: [{ product_id: product.id, qty: 2 }] })
      .expect(409);

    expect(res.body).toMatchObject({ type: `${PROBLEMS}/conflict`, status: 409 });
    expect(await stockOf(product.id)).toBe(1);
    expect((await pg.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(ordersBefore);
  });
});
