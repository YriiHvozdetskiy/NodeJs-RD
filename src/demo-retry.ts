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
 * Конфлікт не залежить від того, чи встигли транзакції перетнутися в часі:
 * точка зустрічі (rendezvous нижче) гарантує, що на першій спробі всі поставки
 * прочитали stock до першого запису, а T1 і T2 тримають свій перший лок до
 * другого UPDATE. Тому кожен сценарій відтворюється на кожному прогоні.
 *
 * Кожен сценарій на власному свіжому товарі. Exit-код залежить від інваріанту,
 * а не від кількості повторів: C і D мусять зійтись арифметично, і за весь
 * прогін має бути впіймано хоча б один 40001 або 40P01 — інакше retry-обгортка
 * нічого не довела.
 */
const SUPPLIERS = 6;
const DELTA = 5;
const INITIAL_STOCK = 100;

/**
 * Точка зустрічі для `parties` транзакцій: кожна чекає, поки дійдуть усі.
 * Відкривається один раз і назавжди. Повтор після 40001/40P01 проходить крізь
 * уже відкриту точку, інакше жертва чекала б на тих, хто давно закомітився.
 *
 * ⚠ `parties` не більше за розмір пулу (10 за замовчуванням): транзакція, якій
 * не дісталось з'єднання, до точки не дійде, і решта чекатимуть вічно.
 */
function rendezvous(parties: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived >= parties) open();
    return opened;
  };
}

async function freshProduct(label: string): Promise<string> {
  const [row] = await dataSource.query(
    `INSERT INTO products (seller_id, category, title, description, price_cents, stock)
     VALUES ('2', 'sports', $1, 'Товар для demo:retry', 10000, $2) RETURNING id`,
    [`Retry ${label} ${new Date().toISOString()}`, INITIAL_STOCK],
  );
  return row.id;
}

const stockOf = async (id: string): Promise<number> => (await dataSource.query(`SELECT stock FROM products WHERE id = $1`, [id]))[0].stock;

/**
 * Той самий read-modify-write, що й у будь-якому «зручному» коді через ORM:
 * find → поле += n → save. `meet` стоїть між читанням і записом — там, де в
 * реальному коді «щось рахується».
 */
function restock(isolation: IsolationLevel, productId: string, delta: number, meet: () => Promise<void>): Promise<void> {
  return dataSource.transaction(isolation, async (manager) => {
    const [{ stock }] = await sql<{ stock: number }>(manager, `SELECT stock FROM products WHERE id = $1`, [productId]);
    await meet();
    await sql(manager, `UPDATE products SET stock = $2 WHERE id = $1`, [productId, stock + delta]);
  });
}

/** Два UPDATE у заданому порядку. Якщо інша транзакція йде назустріч і обидві вже взяли перший лок — дедлок. */
function adjustPair(first: [string, number], second: [string, number], meet: () => Promise<void>): Promise<void> {
  return dataSource.transaction('READ COMMITTED', async (manager) => {
    await sql(manager, `UPDATE products SET stock = stock + $2 WHERE id = $1`, first);
    await meet();
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

  try {
    console.log(`── demo:retry: ${SUPPLIERS} одночасних поставок по +${DELTA} до stock = ${INITIAL_STOCK}, очікуємо ${expected} ──\n`);

    // ── A ─────────────────────────────────────────────────────────────────
    const a = await freshProduct('A');
    const meetA = rendezvous(SUPPLIERS);
    await Promise.all(Array.from({ length: SUPPLIERS }, () => restock('READ COMMITTED', a, DELTA, meetA)));
    const aStock = await stockOf(a);
    console.log(`A. READ COMMITTED, без retry: у базі ${aStock} замість ${expected} — втрачено ${(expected - aStock) / DELTA} з ${SUPPLIERS} поставок.`);
    console.log('   Помилок 0: кожен UPDATE дочекався локу й переписав число, яке порахував зі старого читання. Так виглядає lost update.\n');

    // ── B ─────────────────────────────────────────────────────────────────
    const b = await freshProduct('B');
    const meetB = rendezvous(SUPPLIERS);
    const bResults = await Promise.allSettled(Array.from({ length: SUPPLIERS }, () => restock('REPEATABLE READ', b, DELTA, meetB)));
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
    const meetC = rendezvous(SUPPLIERS);
    await Promise.all(
      Array.from({ length: SUPPLIERS }, (_, i) =>
        withRetry(() => restock('REPEATABLE READ', c, DELTA, meetC), { label: `поставка-${i + 1}`, maxAttempts: 10, onRetry }),
      ),
    );
    const cStock = await stockOf(c);
    const cOk = cStock === expected;
    const serializationRetries = caught.get('40001') ?? 0;
    console.log(`   успішних ${SUPPLIERS}/${SUPPLIERS}, повторів через 40001: ${serializationRetries}; у базі ${cStock} ${cOk ? '=' : '≠'} ${INITIAL_STOCK} + ${SUPPLIERS}×${DELTA} ${cOk ? '✓' : '✗'}\n`);

    // ── D ─────────────────────────────────────────────────────────────────
    const x = await freshProduct('D-x');
    const y = await freshProduct('D-y');
    console.log('D. Дедлок: T1 бере x, потім y; T2 бере y, потім x (Postgres помічає цикл за deadlock_timeout = 1 с):');
    const meetD = rendezvous(2);
    await Promise.all([
      withRetry(() => adjustPair([x, -3], [y, +3], meetD), { label: 'T1 x→y', onRetry }),
      withRetry(() => adjustPair([y, -2], [x, +2], meetD), { label: 'T2 y→x', onRetry }),
    ]);
    const [xStock, yStock] = [await stockOf(x), await stockOf(y)];
    const dOk = xStock === INITIAL_STOCK - 1 && yStock === INITIAL_STOCK + 1;
    const deadlockRetries = caught.get('40P01') ?? 0;
    console.log(`   повторів через 40P01: ${deadlockRetries}; x = ${xStock} (очікували ${INITIAL_STOCK - 1}), y = ${yStock} (очікували ${INITIAL_STOCK + 1}) ${dOk ? '✓' : '✗'}\n`);

    // Кількість повторів — не інваріант: при іншому розкладі їх буде більше
    // чи менше. Інваріант — арифметика C і D плюс факт, що обгортка хоч раз
    // спрацювала на одному з двох кодів.
    const ok = cOk && dOk && serializationRetries + deadlockRetries > 0;

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
