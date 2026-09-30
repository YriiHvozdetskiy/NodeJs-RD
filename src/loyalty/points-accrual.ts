import type { Queryable } from '../db/queryable';

/**
 * Нарахування бонусних балів за оформлене замовлення — ефект споживача
 * order.placed (#19).
 *
 * Правило з docs/design-notes.md, «Бонусні бали»: 1 бал за кожні повні 100 грн
 * позицій БЕЗ акції; запис `earned` у статусі `pending`, дозріває через 14 днів
 * від оформлення. `pending` витратити не можна — його переводить у
 * `available` періодичний прохід (#23).
 */
export const CENTS_PER_POINT = 100_00;
export const MATURITY_DAYS = 14;

export type AccrualOutcome =
  /** Рядок `earned` вставлено саме цим викликом. */
  | { kind: 'applied'; points: number }
  /** Нарахування за це замовлення вже є: повторна доставка тієї самої події. */
  | { kind: 'duplicate' }
  /** Позицій без акції менше ніж на 100 грн — нараховувати нічого. */
  | { kind: 'not-eligible' };

/**
 * Ідемпотентність тут — властивість ДАНИХ, а не коду: унікальний індекс
 * `points_entries_one_earned_per_order` дозволяє рівно одне нарахування на
 * замовлення, і `ON CONFLICT … DO NOTHING` перетворює другу спробу на
 * «0 рядків» замість другого нарахування. Ключ — природний ключ бізнес-операції
 * (order_id), а не eventId: «бали за замовлення 42» — це один факт, скільки б
 * подій про нього не приїхало.
 *
 * Жодного `if (вже нараховано)` перед INSERT: між перевіркою й записом два
 * споживачі на двох подах обидва побачили б «ще ні». Індекс серіалізує їх у
 * Postgres — другий INSERT чекає на COMMIT першого й отримує конфлікт.
 *
 * Один оператор: знайти замовлення, порахувати базу й вставити — в одному
 * знімку, без вікна між кроками.
 */
const ACCRUE = `
  WITH target AS (
    SELECT o.id, o.buyer_id, o.created_at,
           COALESCE((SELECT sum(i.unit_price_cents * i.qty)
                       FROM order_items i
                      WHERE i.order_id = o.id AND i.promotion_id IS NULL), 0) AS base_cents
      FROM orders o
     WHERE o.id = $1
  ), accrued AS (
    INSERT INTO points_entries (user_id, order_id, kind, amount, status, matures_at)
    SELECT buyer_id, id, 'earned', (base_cents / $2)::int, 'pending', created_at + make_interval(days => $3)
      FROM target
     WHERE base_cents >= $2
    ON CONFLICT (order_id) WHERE kind = 'earned' DO NOTHING
    RETURNING amount
  )
  SELECT EXISTS (SELECT 1 FROM target)   AS found,
         (SELECT base_cents FROM target) AS base_cents,
         (SELECT amount FROM accrued)    AS points`;

interface AccrueRow {
  found: boolean;
  /** sum(integer) у Postgres — bigint, і pg віддає його рядком. */
  base_cents: string | null;
  points: number | null;
}

export async function accruePoints(db: Queryable, orderId: string): Promise<AccrualOutcome> {
  const { rows } = await db.query<AccrueRow>(ACCRUE, [orderId, CENTS_PER_POINT, MATURITY_DAYS]);
  const [row] = rows;
  // Подія валідна, а замовлення немає. Споживач не може знати, це назавжди
  // (битий продюсер) чи тимчасово (читання з репліки, що відстала), — тому це
  // звичайна помилка з повтором, і межу повторам ставить delivery-limit.
  if (!row?.found) throw new Error(`замовлення ${orderId} не знайдено`);
  if (row.points !== null) return { kind: 'applied', points: row.points };
  if (Number(row.base_cents) < CENTS_PER_POINT) return { kind: 'not-eligible' };
  return { kind: 'duplicate' };
}
