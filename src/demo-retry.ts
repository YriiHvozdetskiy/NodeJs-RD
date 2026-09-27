import { setTimeout as sleep } from 'node:timers/promises';
import type { IsolationLevel } from 'typeorm/driver/types/IsolationLevel';
import dataSource from './data-source';
import { withRetry, type RetryEvent } from './db/retry';
import { pgErrorField, sql } from './db/sql';

/**
 * Serialization failure і retry на сценарії «поставка на склад»: SUPPLIERS
 * постачальників одночасно додають по DELTA одиниць до одного товару через
 * read-modify-write у JS (прочитали stock → порахували → записали число).
 *
 *   A. READ COMMITTED, без retry     — lost update: база мовчки приймає всі записи
 *                                      поверх одне одного (для порівняння);
 *   B. REPEATABLE READ, без retry    — Postgres помічає конфлікт і кидає 40001,
 *                                      дані цілі, але виклики отримали помилку;
 *   C. REPEATABLE READ + withRetry   — ловимо 40001, повторюємо транзакцію
 *                                      ЦІЛКОМ (з новим читанням), усі проходять;
 *   D. дедлок + withRetry            — два коригування двох товарів у зустрічному
 *                                      порядку, Postgres відкочує одне з 40P01.
 *
 * Кожен сценарій на власному свіжому товарі. Exit ≠ 0, якщо C або D не зійшлись
 * арифметично або не впіймано жодного 40001/40P01.
 */
const SUPPLIERS = 6;
const DELTA = 5;
const INITIAL_STOCK = 100;
/** Пауза між читанням і записом — місце, де в реальному коді «щось рахується». */
const READ_WRITE_GAP_MS = 50;

async function freshProduct(label: string): Promise<string> {
  const [row] = await dataSource.query(
    `INSERT INTO products (seller_id, category, title, description, price_cents, stock)
     VALUES ('2', 'sports', $1, 'Товар для demo:retry', 10000, $2) RETURNING id`,
    [`Retry ${label} ${new Date().toISOString()}`, INITIAL_STOCK],
  );
  return row.id;
}

const stockOf = async (id: string): Promise<number> => (await dataSource.query(`SELECT stock FROM products WHERE id = $1`, [id]))[0].stock;

/** Той самий read-modify-write, що й у будь-якому «зручному» коді через ORM: find → поле += n → save. */
function restock(isolation: IsolationLevel, productId: string, delta: number): Promise<void> {
  return dataSource.transaction(isolation, async (manager) => {
    const [{ stock }] = await sql<{ stock: number }>(manager, `SELECT stock FROM products WHERE id = $1`, [productId]);
    await sleep(READ_WRITE_GAP_MS);
    await sql(manager, `UPDATE products SET stock = $2 WHERE id = $1`, [productId, stock + delta]);
  });
}

/** Два UPDATE у заданому порядку з паузою між ними — рецепт дедлоку, якщо інша транзакція йде назустріч. */
function adjustPair(first: [string, number], second: [string, number]): Promise<void> {
  return dataSource.transaction('READ COMMITTED', async (manager) => {
    await sql(manager, `UPDATE products SET stock = stock + $2 WHERE id = $1`, first);
    await sleep(READ_WRITE_GAP_MS);
    await sql(manager, `UPDATE products SET stock = stock + $2 WHERE id = $1`, second);
  });
}

async function main() {
  await dataSource.initialize();
  const caught = new Map<string, number>();
  const onRetry = (e: RetryEvent) => {
    caught.set(e.code, (caught.get(e.code) ?? 0) + 1);
    console.log(`   [retry] ${e.label}: ${e.code}, спроба ${e.attempt}/${e.maxAttempts} впала — повтор з BEGIN через ${e.delayMs} мс`);
  };
  const expected = INITIAL_STOCK + SUPPLIERS * DELTA;
  let ok = true;

  try {
    // Усі з'єднання відкриті заздалегідь, щоб транзакції справді стартували разом.
    await Promise.all(Array.from({ length: SUPPLIERS }, () => dataSource.query('SELECT pg_sleep(0.05)')));

    console.log(`── demo:retry: ${SUPPLIERS} одночасних поставок по +${DELTA} до stock = ${INITIAL_STOCK}, очікуємо ${expected} ──\n`);

    // ── A ─────────────────────────────────────────────────────────────────
    const a = await freshProduct('A');
    await Promise.all(Array.from({ length: SUPPLIERS }, () => restock('READ COMMITTED', a, DELTA)));
    const aStock = await stockOf(a);
    console.log(`A. READ COMMITTED, без retry: у базі ${aStock} замість ${expected} — втрачено ${(expected - aStock) / DELTA} з ${SUPPLIERS} поставок.`);
    console.log('   Помилок 0: кожен UPDATE дочекався локу й переписав число, яке порахував зі старого читання. Так виглядає lost update.\n');

    // ── B ─────────────────────────────────────────────────────────────────
    const b = await freshProduct('B');
    const bResults = await Promise.allSettled(Array.from({ length: SUPPLIERS }, () => restock('REPEATABLE READ', b, DELTA)));
    const bFailed = bResults.filter((r) => r.status === 'rejected').map((r) => pgErrorField(r.reason, 'code') ?? 'other');
    const bStock = await stockOf(b);
    console.log(
      `B. REPEATABLE READ, без retry: успішних ${SUPPLIERS - bFailed.length}/${SUPPLIERS}, ` +
        `помилки: ${bFailed.join(', ') || '—'}; у базі ${bStock} = ${INITIAL_STOCK} + ${(bStock - INITIAL_STOCK) / DELTA}×${DELTA}.`,
    );
    console.log('   Даних не втрачено, але поставки, що впали, треба комусь повторити.\n');

    // ── C ─────────────────────────────────────────────────────────────────
    const c = await freshProduct('C');
    console.log('C. REPEATABLE READ + withRetry:');
    await Promise.all(
      Array.from({ length: SUPPLIERS }, (_, i) =>
        withRetry(() => restock('REPEATABLE READ', c, DELTA), { label: `поставка-${i + 1}`, maxAttempts: 10, onRetry }),
      ),
    );
    const cStock = await stockOf(c);
    const cOk = cStock === expected;
    const serializationRetries = caught.get('40001') ?? 0;
    console.log(`   успішних ${SUPPLIERS}/${SUPPLIERS}, повторів через 40001: ${serializationRetries}; у базі ${cStock} ${cOk ? '=' : '≠'} ${INITIAL_STOCK} + ${SUPPLIERS}×${DELTA} ${cOk ? '✓' : '✗'}\n`);
    ok &&= cOk && serializationRetries > 0;

    // ── D ─────────────────────────────────────────────────────────────────
    const x = await freshProduct('D-x');
    const y = await freshProduct('D-y');
    console.log('D. Дедлок: T1 бере x, потім y; T2 бере y, потім x (Postgres помічає цикл за deadlock_timeout = 1 с):');
    await Promise.all([
      withRetry(() => adjustPair([x, -3], [y, +3]), { label: 'T1 x→y', onRetry }),
      withRetry(() => adjustPair([y, -2], [x, +2]), { label: 'T2 y→x', onRetry }),
    ]);
    const [xStock, yStock] = [await stockOf(x), await stockOf(y)];
    const dOk = xStock === INITIAL_STOCK - 1 && yStock === INITIAL_STOCK + 1;
    const deadlockRetries = caught.get('40P01') ?? 0;
    console.log(`   повторів через 40P01: ${deadlockRetries}; x = ${xStock} (очікували ${INITIAL_STOCK - 1}), y = ${yStock} (очікували ${INITIAL_STOCK + 1}) ${dOk ? '✓' : '✗'}\n`);
    ok &&= dOk && deadlockRetries > 0;

    console.log(`Підсумок: піймано 40001 × ${serializationRetries}, 40P01 × ${deadlockRetries}; фінальний стан ${ok ? 'сходиться ✓' : 'НЕ сходиться ✗'}`);
    if (!ok) process.exitCode = 1;
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
