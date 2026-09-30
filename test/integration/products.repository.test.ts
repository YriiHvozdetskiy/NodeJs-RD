import { ProductsRepository } from '../../src/catalog/products.repository';
import type { Page } from '../../src/common/cursor';
import { aProduct } from '../testkit/builders';
import { rollbackEachTest } from '../testkit/isolation';
import { startPostgres, type TestPostgres } from '../testkit/postgres';

describe('ProductsRepository · Postgres 16 у testcontainers', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const db = rollbackEachTest(() => pg.pool);

  /** Гортає каталог сторінками по `limit`, доки сервер не скаже «далі нічого». */
  async function allPages(repo: ProductsRepository, limit: number): Promise<number[][]> {
    const pages: number[][] = [];
    let cursor: string | undefined;
    do {
      const page: Page<{ id: number }> = await repo.page(limit, cursor);
      pages.push(page.items.map((p) => p.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return pages;
  }

  test('findById віддає товар у формі спеки: id числом, ціна в копійках, без службових колонок', async () => {
    const product = await aProduct().withPrice(260_000).insert(db());

    const found = await new ProductsRepository(db()).findById(product.id);

    expect(found).toEqual({
      id: product.id,
      title: product.title,
      price_cents: 260_000,
      currency: 'UAH',
      created_at: expect.any(Date),
    });
  });

  test('findById: немає товару → null; id поза bigint → теж null, а не помилка Postgres', async () => {
    const repo = new ProductsRepository(db());

    expect(await repo.findById(999_999)).toBeNull();
    expect(await repo.findById(1e20)).toBeNull();
  });

  test('page: однаковий created_at — порядок тримає id, жоден товар не губиться й не повторюється', async () => {
    // Усі INSERT-и тесту — в одній транзакції, а now() у Postgres — час її
    // початку. Тож у п'яти товарів created_at однаковий до мікросекунди.
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await aProduct().insert(db())).id);

    const pages = await allPages(new ProductsRepository(db()), 2);

    expect(pages).toEqual([
      [ids[4], ids[3]],
      [ids[2], ids[1]],
      [ids[0]],
    ]);
  });

  test('page: курсор тримає мікросекунди — товари з однієї мілісекунди не випадають зі сторінок', async () => {
    // Три товари в межах 0.2 мс. Курсор із мілісекундами (як у JS Date)
    // округлив би позицію до …00.000Z і відрізав би два старші товари.
    const oldest = await aProduct().createdAt('2026-09-30T10:00:00.000100Z').insert(db());
    const middle = await aProduct().createdAt('2026-09-30T10:00:00.000200Z').insert(db());
    const newest = await aProduct().createdAt('2026-09-30T10:00:00.000300Z').insert(db());

    const pages = await allPages(new ProductsRepository(db()), 1);

    expect(pages).toEqual([[newest.id], [middle.id], [oldest.id]]);
  });

  test('FOREIGN KEY: товар без наявного продавця база не приймає (23503)', async () => {
    await expect(aProduct().bySeller(999_999).insert(db())).rejects.toMatchObject({
      code: '23503',
      constraint: 'products_seller_id_fkey',
    });
  });
});
