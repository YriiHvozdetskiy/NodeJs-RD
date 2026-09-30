import { DataSource, In } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { Order, OrderItem, Product } from './entities';
import { QueryCountLogger } from './query-count-logger';

/**
 * N+1 на реальному для домену запиті: «сторінка замовлень із позиціями й
 * товарами» — граф order → items → product, два рівні зв'язків.
 *
 * Кожну стратегію проганяємо на кількох розмірах вибірки. Сам факт
 * «після = 1» ще нічого не доводить; доводить те, що «до» росте разом із N,
 * а «після» лишається тим самим числом на кожному N.
 *
 * Розміри — аргументами або змінною оточення, без них — 5 і 10 (стільки
 * замовлень дає seed):
 *   npm run demo:nplus1 -- 5 10 20
 *   NPLUS1_SIZES=5,10,20 npm run demo:nplus1
 * Id не вгадуються: демо бере перші N замовлень, які реально є в базі, тож
 * на більшій базі воно міряє більшу вибірку, а не ті самі десять рядків.
 */
const logger = new QueryCountLogger(['query']);
const dataSource = new DataSource({ ...dataSourceOptions, logging: ['query'], logger });

interface Loaded {
  orders: number;
  items: number;
  units: number;
}

interface Measurement {
  strategy: string;
  queries: number[];
  items: number[];
}

const DEFAULT_SIZES = [5, 10];

/**
 * Розміри з argv (`5 10 20` або `5,10,20`), інакше з NPLUS1_SIZES, інакше
 * дефолт. Мінімум два різні розміри: з одного не видно ні росту «до», ні
 * сталості «після».
 */
function parseSizes(): number[] {
  const args = process.argv.slice(2);
  const raw = args.length > 0 ? args.join(',') : (process.env.NPLUS1_SIZES ?? '');
  if (raw.trim() === '') return DEFAULT_SIZES;

  const parts = raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
  const invalid = parts.find((part) => !/^[1-9]\d*$/.test(part));
  if (invalid !== undefined) throw new Error(`Розмір вибірки має бути цілим числом ≥ 1, отримано «${invalid}»`);
  const sizes = parts.map(Number);

  const unique = [...new Set(sizes)].sort((a, b) => a - b);
  if (unique.length < 2) throw new Error('Потрібно щонайменше два різні розміри, наприклад: npm run demo:nplus1 -- 5 10');
  return unique;
}

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
  const sizes = parseSizes();
  const maxSize = sizes[sizes.length - 1];

  await dataSource.initialize();
  try {
    // Перші maxSize замовлень, які справді є в базі. Цей запит не входить у
    // заміри: лічильник скидається перед кожною стратегією.
    const available = await dataSource
      .getRepository(Order)
      .find({ select: { id: true }, order: { id: 'ASC' }, take: maxSize });
    if (available.length < maxSize) {
      throw new Error(
        `Запитано N = ${maxSize}, а замовлень у базі ${available.length}. ` +
          'Зменш розмір або налий більше даних (npm run seed дає 10).',
      );
    }
    const orderIds = available.map((o) => o.id);
    const idsFor = (n: number) => orderIds.slice(0, n);

    console.log(`── Як N+1 виглядає в лозі SQL (наївно, N = ${sizes[0]}) ──`);
    logger.echo = true;
    logger.reset();
    await strategies['наївно (запит у циклі)'](idsFor(sizes[0]));
    logger.echo = false;

    const measurements: Measurement[] = [];
    for (const [strategy, run] of Object.entries(strategies)) {
      const measurement: Measurement = { strategy, queries: [], items: [] };
      for (const n of sizes) {
        logger.reset();
        const loaded = await run(idsFor(n));
        measurement.queries.push(logger.count);
        measurement.items.push(loaded.items);
      }
      measurements.push(measurement);
    }

    console.log('\n── Кількість SQL-запитів «до» і «після» ──');
    console.table(
      measurements.map((m) =>
        Object.fromEntries([
          ['стратегія', m.strategy],
          ...sizes.map((n, i) => [`N=${n} (${m.items[i]} поз.)`, m.queries[i]]),
        ]),
      ),
    );

    const [naive, ...fixed] = measurements;
    const grows = naive.queries.every((count, i) => i === 0 || count > naive.queries[i - 1]);
    const constant = fixed.every((m) => m.queries.every((count) => count === m.queries[0]));
    console.log(
      `До: ${naive.queries.join(' → ')} (росте з N: ${grows ? 'так' : 'НІ'}). ` +
        `Після: ${fixed.map((m) => m.queries[0]).join(' / ')} (не залежить від N: ${constant ? 'так' : 'НІ'}).`,
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
