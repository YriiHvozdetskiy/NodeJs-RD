import { DataSource, In } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { Order, OrderItem, Product } from './entities';
import { QueryCountLogger } from './query-count-logger';

/**
 * N+1 на реальному для домену запиті: «сторінка замовлень із позиціями й
 * товарами» — граф order → items → product, два рівні зв'язків.
 *
 * Кожну стратегію проганяємо на двох розмірах вибірки (5 і 10 замовлень).
 * Сам факт «після = 1» ще нічого не доводить; доводить те, що «до» росте
 * разом із N, а «після» лишається тим самим числом.
 *
 * Потрібен seed (`npm run seed`): id замовлень 1…10.
 */
const logger = new QueryCountLogger(['query']);
const dataSource = new DataSource({ ...dataSourceOptions, logging: ['query'], logger });

type Loaded = { orders: number; items: number; units: number };

/** Однаковий підсумок з кожної стратегії — доказ, що фікс віддає ті самі дані. */
function summarize(orders: { items: { qty: number; product: Product }[] }[]): Loaded {
  const items = orders.flatMap((o) => o.items);
  if (items.some((i) => !i.product)) throw new Error('товар не завантажено');
  return { orders: orders.length, items: items.length, units: items.reduce((s, i) => s + i.qty, 0) };
}

const strategies: Record<string, (ids: string[]) => Promise<Loaded>> = {
  // Так пишеться «очевидний» код: спершу список, далі дочитуємо зв'язки в циклі.
  // SQL: 1 за замовленнями + 1 на кожне замовлення + 1 на кожну позицію.
  async 'наївно (запит у циклі)'(ids) {
    const orders = await dataSource.getRepository(Order).find({ where: { id: In(ids) }, order: { id: 'ASC' } });
    const graph = [];
    for (const order of orders) {
      const items = await dataSource.getRepository(OrderItem).find({ where: { orderId: order.id } });
      for (const item of items) {
        item.product = await dataSource.getRepository(Product).findOneByOrFail({ id: item.productId });
      }
      graph.push({ ...order, items });
    }
    return summarize(graph);
  },

  // Фікс №1: той самий find(), але граф зв'язків описано наперед → один SELECT з LEFT JOIN.
  async 'find({ relations })'(ids) {
    const orders = await dataSource.getRepository(Order).find({
      where: { id: In(ids) },
      relations: { items: { product: true } },
      order: { id: 'ASC' },
    });
    return summarize(orders);
  },

  // Фікс №2: те саме явним QueryBuilder'ом — коли джойн треба контролювати руками.
  async 'leftJoinAndSelect'(ids) {
    const orders = await dataSource
      .getRepository(Order)
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.items', 'item')
      .leftJoinAndSelect('item.product', 'product')
      .where('o.id IN (:...ids)', { ids })
      .orderBy('o.id', 'ASC')
      .getMany();
    return summarize(orders);
  },

  // Фікс №3: без JOIN, окремий запит на кожен РІВЕНЬ зв'язку, а не на кожен рядок.
  // Корисно, коли JOIN роздуває результат (1 замовлення × 200 позицій × широкий товар).
  async "relationLoadStrategy: 'query'"(ids) {
    const orders = await dataSource.getRepository(Order).find({
      where: { id: In(ids) },
      relations: { items: { product: true } },
      relationLoadStrategy: 'query',
      order: { id: 'ASC' },
    });
    return summarize(orders);
  },
};

async function main() {
  await dataSource.initialize();
  try {
    const sizes = [5, 10];
    const idsFor = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));

    console.log(`── Як N+1 виглядає в лозі SQL (наївно, N = ${sizes[0]}) ──`);
    logger.echo = true;
    logger.reset();
    await strategies['наївно (запит у циклі)'](idsFor(sizes[0]));
    logger.echo = false;

    const rows: Record<string, string | number>[] = [];
    for (const [name, run] of Object.entries(strategies)) {
      const row: Record<string, string | number> = { стратегія: name };
      for (const n of sizes) {
        logger.reset();
        const loaded = await run(idsFor(n));
        row[`запитів, N=${n}`] = logger.count;
        row[`позицій, N=${n}`] = loaded.items;
      }
      rows.push(row);
    }

    console.log('\n── Кількість SQL-запитів «до» і «після» ──');
    console.table(rows);

    const [naive, ...fixed] = rows;
    const grows = naive[`запитів, N=${sizes[1]}`] > naive[`запитів, N=${sizes[0]}`];
    const constant = fixed.every((r) => r[`запитів, N=${sizes[0]}`] === r[`запитів, N=${sizes[1]}`]);
    console.log(
      `До: ${naive[`запитів, N=${sizes[0]}`]} → ${naive[`запитів, N=${sizes[1]}`]} (росте з N: ${grows ? 'так' : 'НІ'}). ` +
        `Після: ${fixed.map((r) => r[`запитів, N=${sizes[1]}`]).join(' / ')} (не залежить від N: ${constant ? 'так' : 'НІ'}).`,
    );
    if (!grows || !constant) process.exitCode = 1;
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
