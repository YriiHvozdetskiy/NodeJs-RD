import { OrdersRepository } from '../../src/orders/orders.repository';
import { aProduct, anOrder, type InsertedOrder } from '../testkit/builders';
import { rollbackEachTest } from '../testkit/isolation';
import { startPostgres, type TestPostgres } from '../testkit/postgres';

describe('OrdersRepository · Postgres 16 у testcontainers', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const db = rollbackEachTest(() => pg.pool);

  test('findById збирає позиції JOIN-ом і json_agg: числа, а не рядки bigint, у порядку id товару', async () => {
    const keyboard = await aProduct().withPrice(260_000).insert(db());
    const mouse = await aProduct().withPrice(380_000).insert(db());
    // Позиції навмисно в зворотному порядку — сортування має дати база.
    const order = await anOrder().withLine(mouse, 1).withLine(keyboard, 2).insert(db());

    const found = await new OrdersRepository(db()).findById(order.id);

    expect(found).toEqual({
      id: order.id,
      items: [
        { product_id: keyboard.id, qty: 2, unit_price_cents: 260_000 },
        { product_id: mouse.id, qty: 1, unit_price_cents: 380_000 },
      ],
      total_cents: 900_000,
      currency: 'UAH',
      status: 'pending',
      created_at: expect.any(Date),
    });
  });

  test('page: LIMIT рахує замовлення, а не рядки JOIN-а — жодне не обрізане посередині', async () => {
    const products = [await aProduct().insert(db()), await aProduct().insert(db()), await aProduct().insert(db())];
    const orders: InsertedOrder[] = [];
    for (const createdAt of ['2026-09-30T10:00:01.000000Z', '2026-09-30T10:00:02.000000Z', '2026-09-30T10:00:03.000000Z']) {
      const builder = anOrder().createdAt(createdAt);
      for (const product of products) builder.withLine(product);
      orders.push(await builder.insert(db()));
    }
    const repo = new OrdersRepository(db());

    const first = await repo.page(2);
    const second = await repo.page(2, first.next_cursor ?? undefined);

    expect(first.items.map((o) => [o.id, o.items.length])).toEqual([
      [orders[2].id, 3],
      [orders[1].id, 3],
    ]);
    expect(second.items.map((o) => [o.id, o.items.length])).toEqual([[orders[0].id, 3]]);
    expect(second.next_cursor).toBeNull();
  });

  test('FOREIGN KEY RESTRICT: товар, який хтось купив, не видалити (23503)', async () => {
    const order = await anOrder().insert(db());

    await expect(db().query('DELETE FROM products WHERE id = $1', [order.lines[0].productId])).rejects.toMatchObject({
      code: '23503',
      constraint: 'order_items_product_id_fkey',
    });
  });

  test('CHECK: сума, що не сходиться з subtotal − discount, у базу не потрапляє (23514)', async () => {
    const order = await anOrder().insert(db());

    await expect(db().query('UPDATE orders SET total_cents = total_cents + 1 WHERE id = $1', [order.id])).rejects.toMatchObject({
      code: '23514',
      constraint: 'orders_total_consistency_check',
    });
  });
});
