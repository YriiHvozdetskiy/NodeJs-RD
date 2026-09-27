import { performance } from 'node:perf_hooks';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { checkout, CheckoutError } from './checkout/checkout';
import { sql } from './db/sql';

/**
 * 50 одночасних checkout на один товар зі stock = 10, по одній штуці.
 *
 *   npm run demo:race              — справжній checkout, очікувано рівно 10 успішних
 *   npm run demo:race -- --naive   — read-modify-write у JS, щоб побачити oversell
 *
 * Кожен прогін створює СВІЙ товар: попередні прогони й seed не впливають на
 * числа, а повторний запуск не потребує жодного скидання.
 *
 * Хто купує: покупці 4–7 мають у сіді по 1 000 000 балів, тож обмежує їх лише
 * stock, і число успішних детерміноване.
 *
 * Перед гонкою — перевірка відкату: покупець 8 (0 доступних балів) пробує
 * купити той самий товар. Його checkout падає ПІСЛЯ того, як уже зменшив stock,
 * тож stock = 10 після відмови доводить, що ROLLBACK забрав і декремент.
 * Усередині гонки така спроба нічого б не довела: чи встигне вона до товару
 * раніше, ніж stock скінчиться, вирішує порядок з'єднань, а не код.
 *
 * Потрібні migrate + seed.
 */
const ATTEMPTS = 50;
const INITIAL_STOCK = 10;
const QTY = 1;
const POINTS_PER_ORDER = 100;
const PRICE_CENTS = 100_000;
const RICH_BUYERS = ['4', '5', '6', '7'];
const BROKE_BUYER = '8';

const naive = process.argv.includes('--naive');

// 50 паралельних транзакцій — 50 з'єднань. Пул за замовчуванням має 10, і
// решта чекали б у черзі пулу: результат той самий, але гонка слабша.
// Postgres у compose має max_connections = 100.
const dataSource = new DataSource({ ...dataSourceOptions, poolSize: ATTEMPTS + 5 });

/**
 * Антипатерн для порівняння: прочитали залишок, перевірили в JS, записали
 * обчислене значення. Між SELECT і UPDATE — вікно, у яке встигають зазирнути
 * всі 50 транзакцій: кожна бачить stock = 10 і пише 9.
 * CHECK (stock >= 0) тут не рятує — від'ємного числа ніхто й не пише.
 */
async function naiveCheckout(productId: string, buyerId: string): Promise<string> {
  return dataSource.transaction(async (manager) => {
    const [product] = await sql<{ stock: number; price_cents: number }>(
      manager,
      `SELECT stock, price_cents FROM products WHERE id = $1`,
      [productId],
    );
    if (product.stock < QTY) throw new CheckoutError('out_of_stock', 'закінчився');
    await sql(manager, `UPDATE products SET stock = $2 WHERE id = $1`, [productId, product.stock - QTY]);
    const [order] = await sql<{ id: string }>(
      manager,
      `INSERT INTO orders (buyer_id, region, subtotal_cents, total_cents) VALUES ($1, 'UA', $2, $2) RETURNING id`,
      [buyerId, product.price_cents * QTY],
    );
    await sql(
      manager,
      `INSERT INTO order_items (order_id, product_id, qty, unit_price_cents) VALUES ($1, $2, $3, $4)`,
      [order.id, productId, QTY, product.price_cents],
    );
    return order.id;
  });
}

async function main() {
  await dataSource.initialize();
  try {
    const [product] = await dataSource.query(
      `INSERT INTO products (seller_id, category, title, description, price_cents, stock)
       VALUES ('3', 'electronics', $1, 'Лімітований дроп для demo:race', $2, $3)
       RETURNING id`,
      [`Race drop ${new Date().toISOString()}`, PRICE_CENTS, INITIAL_STOCK],
    );
    const productId: string = product.id;

    // Прогрів пулу: відкриваємо всі з'єднання заздалегідь, щоб 50 checkout
    // стартували одночасно, а не по мірі TCP + auth handshake кожного.
    await Promise.all(Array.from({ length: ATTEMPTS }, () => dataSource.query('SELECT pg_sleep(0.05)')));

    const buyers = Array.from({ length: ATTEMPTS }, (_, i) => RICH_BUYERS[i % RICH_BUYERS.length]);

    console.log(
      `── demo:race${naive ? ' --naive' : ''}: ${ATTEMPTS} паралельних checkout на товар #${productId} ` +
        `(stock = ${INITIAL_STOCK}, qty = ${QTY}) ──`,
    );

    if (!naive) {
      const reason = await checkout(dataSource, { buyerId: BROKE_BUYER, lines: [{ productId, qty: QTY }], pointsToSpend: POINTS_PER_ORDER }).then(
        () => 'ok',
        (err: unknown) => (err instanceof CheckoutError ? err.reason : String(err)),
      );
      const [probe] = await dataSource.query(
        `SELECT stock, (SELECT count(*)::int FROM order_items WHERE product_id = $1) AS items FROM products WHERE id = $1`,
        [productId],
      );
      const rolledBack = reason === 'insufficient_points' && probe.stock === INITIAL_STOCK && probe.items === 0;
      console.log(`перевірка відкату: покупець без балів → ${reason}; stock ${probe.stock}, позицій ${probe.items} ${rolledBack ? '✓' : '✗'}`);
      if (!rolledBack) process.exitCode = 1;
    }

    const started = performance.now();
    // Promise.all без жодної черги в застосунку: усі 50 викликів уже в польоті,
    // серіалізує їх (або ні) лише Postgres.
    const outcomes = await Promise.all(
      buyers.map((buyerId) =>
        (naive
          ? naiveCheckout(productId, buyerId)
          : checkout(dataSource, { buyerId, lines: [{ productId, qty: QTY }], pointsToSpend: POINTS_PER_ORDER }).then((r) => r.orderId)
        ).then(
          () => 'ok',
          (err: unknown) => (err instanceof CheckoutError ? err.reason : `unexpected: ${err instanceof Error ? err.message : err}`),
        ),
      ),
    );
    const elapsedMs = Math.round(performance.now() - started);

    const successes = outcomes.filter((o) => o === 'ok').length;
    const failures = new Map<string, number>();
    for (const o of outcomes) if (o !== 'ok') failures.set(o, (failures.get(o) ?? 0) + 1);

    const [state] = await dataSource.query(
      `WITH race_orders AS (SELECT order_id FROM order_items WHERE product_id = $1)
       SELECT p.stock                                                                   AS final_stock,
              (SELECT count(*)::int FROM products WHERE stock < 0)                      AS negative_rows,
              (SELECT COALESCE(sum(qty), 0)::int FROM order_items WHERE product_id = $1) AS sold,
              (SELECT count(*)::int FROM orders o
                WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)) AS orphan_orders,
              (SELECT count(*)::int FROM jobs
                WHERE kind = 'order_receipt'
                  AND (payload->>'orderId')::bigint IN (SELECT order_id FROM race_orders)) AS receipts,
              (SELECT COALESCE(sum(amount), 0)::int FROM points_entries
                WHERE kind = 'spent' AND order_id IN (SELECT order_id FROM race_orders)) AS points_spent,
              (SELECT count(*)::int FROM (
                 SELECT user_id FROM points_entries GROUP BY user_id
                 HAVING COALESCE(SUM(amount) FILTER (WHERE kind = 'earned' AND status = 'available'), 0)
                      < COALESCE(SUM(amount) FILTER (WHERE kind = 'spent'), 0)) AS neg)  AS negative_balances
         FROM products p
        WHERE p.id = $1`,
      [productId],
    );

    const failureSummary = [...failures].map(([reason, n]) => `${reason}: ${n}`).join(', ') || '—';
    console.log(`спроб: ${ATTEMPTS}`);
    console.log(`успішних: ${successes}`);
    console.log(`відмов: ${ATTEMPTS - successes} (${failureSummary})`);
    console.log(`фінальний stock: ${state.final_stock}`);
    console.log(`рядків із відʼємним stock: ${state.negative_rows}`);
    console.log(`продано одиниць (order_items): ${state.sold}`);
    console.log(`замовлень-сиріт (без позицій): ${state.orphan_orders}`);
    if (!naive) {
      console.log(`задач на чек у черзі: ${state.receipts}`);
      console.log(`списано балів: ${state.points_spent} (${successes} × ${POINTS_PER_ORDER})`);
      console.log(`покупців із відʼємним балансом: ${state.negative_balances}`);
    }
    console.log(`час: ${elapsedMs} мс`);

    const invariants: [string, boolean][] = [
      [`продано не більше, ніж було (${state.sold} ≤ ${INITIAL_STOCK}) — інакше oversell`, state.sold <= INITIAL_STOCK],
      [`успішних = продано = ${INITIAL_STOCK} − фінальний stock — інакше втрачений апдейт`, successes === state.sold && state.sold === INITIAL_STOCK - state.final_stock],
      [`успішних рівно ${INITIAL_STOCK} (спроб більше, ніж товару)`, successes === INITIAL_STOCK],
      ['відʼємного stock немає', state.negative_rows === 0],
      ['замовлень-сиріт немає', state.orphan_orders === 0],
      ['неочікуваних помилок немає', ![...failures.keys()].some((r) => r.startsWith('unexpected'))],
    ];
    if (!naive) {
      invariants.push(
        ['на кожне замовлення — рівно одна задача на чек', state.receipts === successes],
        ['списано рівно успішних × бали', state.points_spent === successes * POINTS_PER_ORDER],
        ['відʼємних балансів немає', state.negative_balances === 0],
      );
    }

    const broken = invariants.filter(([, ok]) => !ok);
    for (const [name, ok] of invariants) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (broken.length > 0) {
      console.error(`Інваріант ПОРУШЕНО (${broken.length}): ${naive ? 'очікувано для --naive — саме це й лікує атомарний UPDATE' : 'oversell або втрачений апдейт'}`);
      process.exitCode = 1;
    } else {
      console.log('Інваріант: OK — oversell немає');
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
