import type { DataSource, EntityManager } from 'typeorm';
import { withRetry } from '../db/retry';
import { PG_ERROR, pgErrorField, sql } from '../db/sql';
import { ORDER_AGGREGATE, toOrderPlacedEvent } from '../messaging/order-placed.event';

/**
 * Оформлення замовлення — одна транзакція, у якій або стається все, або нічого:
 *
 *   1. декремент stock кожної позиції — атомарним UPDATE … WHERE stock >= n;
 *   2. ціна зі знижками — знімок у order_items (акції на позицію + промокод);
 *   3. списання балів — під локом рядка покупця;
 *   4. INSERT orders + order_items + points_entries(spent);
 *   5. INSERT jobs — задача на чек, яку виконає воркер (src/queue/worker.ts);
 *   6. INSERT outbox — подія order.placed (#22); у брокер її везе relay;
 *   7. INSERT idempotency_keys — ключ з API-краю, якщо запит його приніс (#22).
 *
 * Будь-який збій на будь-якому кроці — throw, і TypeORM робить ROLLBACK:
 * декремент із кроку 1 зникає разом із рештою, замовлень-«сиріт» не буває. І
 * подій-сиріт теж: рядок outbox відкочується разом із замовленням, тож relay
 * ніколи не побачить подію про замовлення, якого немає (demo:crash-write).
 *
 * Два обмежені ресурси — два різні інструменти, і це свідомо:
 *
 *   • stock — атомарний UPDATE. Перевірка й запис в одному операторі: рядок
 *     блокується на UPDATE, і якщо його щойно змінила інша транзакція,
 *     Postgres після її COMMIT перечитує свіжу версію й перевіряє WHERE знову.
 *     Між «перевірив» і «записав» немає вікна, у яке влізе хтось третій.
 *     0 рядків у RETURNING = товару не вистачило.
 *
 *   • бали — песимістичний лок (SELECT … FOR NO KEY UPDATE на users). Баланс —
 *     не колонка, а SUM по журналу, тож «UPDATE … WHERE balance >= n» просто
 *     нема до чого застосувати: оновлювати нічого, ми лише дописуємо рядок.
 *     Два checkout одного покупця без локу обидва порахували б SUM = 100 і
 *     обидва списали б по 100 (write skew). Лок рядка користувача серіалізує
 *     їх: другий порахує SUM уже після коміту першого.
 */

/** Курс із docs/design-notes.md: 1 бал = 1 копійка. */
const POINT_VALUE_CENTS = 1;
const ORDER_CURRENCY = 'UAH';
/** Скільки живе Idempotency-Key — 24 години зі спеки (`Idempotency-Key`). */
export const IDEMPOTENCY_TTL_HOURS = 24;

export const CHECKOUT_FAILURES = [
  'invalid_input',
  'unknown_product',
  'unknown_buyer',
  'out_of_stock',
  'insufficient_points',
  'points_exceed_limit',
  'promo_code_invalid',
  'promo_code_used',
] as const;
export type CheckoutFailure = (typeof CHECKOUT_FAILURES)[number];

/** Очікувана відмова бізнес-логіки. Не ретраїться: повтор дасть ту саму відповідь. */
export class CheckoutError extends Error {
  constructor(
    readonly reason: CheckoutFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutError';
  }
}

export interface CheckoutLine {
  productId: string;
  qty: number;
}

export interface CheckoutInput {
  buyerId: string;
  lines: CheckoutLine[];
  pointsToSpend?: number;
  promoCode?: string;
  region?: string;
  deviceId?: string;
}

export interface CheckoutResult {
  orderId: string;
  jobId: string;
  buyerId: string;
  currency: string;
  /** `orders.created_at` — момент, коли замовлення стало фактом, а не момент публікації події. */
  placedAt: string;
  /** Позиції після зведення дублікатів — рівно те, що лягло в order_items. */
  lines: CheckoutLine[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  pointsSpent: number;
  /** Скільки лишилось сплатити грошима після балів. Сам платіж — #22. */
  amountDueCents: number;
}

export interface CheckoutOptions {
  /** `Idempotency-Key` з API-краю і sha256 тіла запиту — пишуться в транзакції замовлення. */
  idempotency?: { key: string; fingerprint: string };
  /**
   * Останній крок перед COMMIT, коли замовлення, outbox і ключ уже вставлено.
   * Кинутий звідси виняток відкочує все. Точка, у яку demo:crash-write кладе
   * збій бізнес-запису.
   */
  beforeCommit?: (manager: EntityManager, placed: CheckoutResult) => Promise<void>;
}

/**
 * Ключ уже закомітив інший запит (паралельний, на іншому інстансі чи до
 * рестарту). Транзакцію цього запиту відкочено цілком — разом із другим
 * замовленням і другою подією; відповідь дає вже збережений ключ.
 */
export class IdempotencyKeyTaken extends Error {
  constructor(readonly key: string) {
    super(`Idempotency-Key «${key}» уже використано`);
    this.name = 'IdempotencyKeyTaken';
  }
}

interface PricedLine extends CheckoutLine {
  unitPriceCents: number;
  discountCents: number;
  promotionId: string | null;
}

interface ActivePromotion {
  id: string;
  product_id: string;
  kind: 'seasonal' | 'quantity_tier';
  percent_off: string;
  min_qty: number | null;
}

/** Відсоток знижки → базисні пункти цілим числом: '12.50' → 1250. Вся арифметика далі цілочисельна. */
const basisPoints = (percent: string) => Math.round(Number(percent) * 100);
/** Знижка завжди вниз до цілої копійки — щоб не подарувати зайве (та сама політика, що в сіді). */
const discountOf = (amountCents: number, percent: string) => Math.floor((amountCents * basisPoints(percent)) / 10_000);

export async function checkout(dataSource: DataSource, input: CheckoutInput, options: CheckoutOptions = {}): Promise<CheckoutResult> {
  const lines = normalizeLines(input.lines);
  const pointsToSpend = input.pointsToSpend ?? 0;
  if (!Number.isInteger(pointsToSpend) || pointsToSpend < 0) {
    throw new CheckoutError('invalid_input', `pointsToSpend має бути цілим ≥ 0, отримано ${pointsToSpend}`);
  }

  // READ COMMITTED достатньо: stock захищає атомарний UPDATE, бали — лок.
  // withRetry — страховка від 40P01: порядок локів нижче робить дедлок між
  // двома checkout неможливим, але не між checkout і будь-яким майбутнім
  // кодом, що бере ті самі рядки в іншому порядку.
  return withRetry(
    () => dataSource.transaction('READ COMMITTED', (manager) => placeOrder(manager, { ...input, lines, pointsToSpend }, options)),
    { label: 'checkout' },
  );
}

/**
 * Дублікати товару зводяться в одну позицію (PK order_items — (order_id,
 * product_id)), а позиції сортуються за id. Сортування — це і є захист від
 * дедлоку: два кошики {A, B} і {B, A} без нього блокували б рядки назустріч
 * одне одному. З ним обидва беруть A першим.
 */
function normalizeLines(lines: CheckoutLine[]): CheckoutLine[] {
  if (lines.length === 0) throw new CheckoutError('invalid_input', 'кошик порожній');
  const qtyByProduct = new Map<string, number>();
  for (const { productId, qty } of lines) {
    if (!/^\d+$/.test(productId)) throw new CheckoutError('invalid_input', `некоректний productId «${productId}»`);
    if (!Number.isInteger(qty) || qty <= 0) throw new CheckoutError('invalid_input', `qty має бути цілим > 0, отримано ${qty}`);
    qtyByProduct.set(productId, (qtyByProduct.get(productId) ?? 0) + qty);
  }
  return [...qtyByProduct]
    .map(([productId, qty]) => ({ productId, qty }))
    .sort((a, b) => (BigInt(a.productId) < BigInt(b.productId) ? -1 : 1));
}

async function placeOrder(
  manager: EntityManager,
  input: CheckoutInput & { pointsToSpend: number },
  options: CheckoutOptions,
): Promise<CheckoutResult> {
  const region = input.region ?? 'UA';

  // ── 1. stock: перевірка й декремент одним оператором ─────────────────────
  const unitPrices = new Map<string, number>();
  for (const line of input.lines) {
    const [row] = await sql<{ price_cents: number; currency: string }>(
      manager,
      `UPDATE products
          SET stock = stock - $2
        WHERE id = $1 AND stock >= $2
    RETURNING price_cents, currency`,
      [line.productId, line.qty],
    );
    if (!row) {
      // Лише щоб назвати причину: рядок уже не заблоковано, але відповідь
      // «скільки лишилось» тут інформативна, а не рішення.
      const [current] = await sql<{ stock: number }>(manager, `SELECT stock FROM products WHERE id = $1`, [line.productId]);
      if (!current) throw new CheckoutError('unknown_product', `товару ${line.productId} немає в каталозі`);
      throw new CheckoutError('out_of_stock', `товар ${line.productId}: залишок ${current.stock}, потрібно ${line.qty}`);
    }
    if (row.currency !== ORDER_CURRENCY) {
      throw new CheckoutError('invalid_input', `товар ${line.productId} у ${row.currency}, замовлення лише в ${ORDER_CURRENCY}`);
    }
    unitPrices.set(line.productId, row.price_cents);
  }

  // ── 2. ціна: знімок з акціями, чинними на момент транзакції ──────────────
  // now() у Postgres — час початку транзакції: усі позиції оцінюються на ту
  // саму мить, навіть якщо акція закінчується посеред оформлення.
  const promotions = await sql<ActivePromotion>(
    manager,
    `SELECT id, product_id, kind, percent_off, min_qty
       FROM promotions
      WHERE product_id = ANY($1::bigint[])
        AND kind IN ('seasonal', 'quantity_tier')
        AND region = $2
        AND starts_at <= now() AND now() < ends_at`,
    [input.lines.map((l) => l.productId), region],
  );

  const priced: PricedLine[] = input.lines.map((line) => {
    const unitPriceCents = unitPrices.get(line.productId) ?? 0;
    // Одна акція на позицію — найвигідніша з тих, що підходять (стек акцій
    // свідомо не підтримуємо, README розділ 4).
    const best = promotions
      .filter((p) => p.product_id === line.productId && (p.kind === 'seasonal' || line.qty >= (p.min_qty ?? Infinity)))
      .sort((a, b) => basisPoints(b.percent_off) - basisPoints(a.percent_off))[0];
    return {
      ...line,
      unitPriceCents,
      discountCents: best ? discountOf(unitPriceCents * line.qty, best.percent_off) : 0,
      promotionId: best?.id ?? null,
    };
  });

  const subtotalCents = priced.reduce((sum, l) => sum + l.unitPriceCents * l.qty, 0);
  const itemDiscountCents = priced.reduce((sum, l) => sum + l.discountCents, 0);

  let promoCodeId: string | null = null;
  let codeDiscountCents = 0;
  if (input.promoCode !== undefined) {
    const [code] = await sql<{ id: string; percent_off: string }>(
      manager,
      `SELECT id, percent_off FROM promotions
        WHERE kind = 'promo_code' AND code = $1 AND region = $2
          AND starts_at <= now() AND now() < ends_at`,
      [input.promoCode, region],
    );
    if (!code) throw new CheckoutError('promo_code_invalid', `промокод «${input.promoCode}» не діє`);
    promoCodeId = code.id;
    // Промокод — після автоматичних акцій, на те, що від них лишилось.
    codeDiscountCents = discountOf(subtotalCents - itemDiscountCents, code.percent_off);
  }

  const discountCents = itemDiscountCents + codeDiscountCents;
  const totalCents = subtotalCents - discountCents;

  // ── 3. бали: ліміт → лок покупця → баланс ────────────────────────────────
  const pointsSpent = input.pointsToSpend;
  if (pointsSpent > 0) {
    // Бали не діють на акційні позиції (README розділ 4): межа списання —
    // сума позицій без акції, і не більше, ніж лишилось до сплати.
    const pointsBaseCents = priced.filter((l) => l.promotionId === null).reduce((s, l) => s + l.unitPriceCents * l.qty, 0);
    const limit = Math.floor(Math.min(pointsBaseCents, totalCents) / POINT_VALUE_CENTS);
    if (pointsSpent > limit) {
      throw new CheckoutError('points_exceed_limit', `на це замовлення можна списати не більше ${limit} балів`);
    }

    // FOR NO KEY UPDATE, а не FOR UPDATE: нам потрібен м'ютекс «баланс цього
    // покупця», а не заборона посилатись на рядок. FOR UPDATE конфліктував би
    // з FOR KEY SHARE, який Postgres бере на users при перевірці FK orders.buyer_id —
    // і паралельний checkout того самого покупця БЕЗ балів чекав би без причини.
    // Лок береться ПІСЛЯ товарів: порядок «товари за id → покупець» однаковий
    // у всіх checkout, тож циклу очікування скласти неможливо.
    const [buyer] = await sql<{ id: string }>(manager, `SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE`, [input.buyerId]);
    if (!buyer) throw new CheckoutError('unknown_buyer', `покупця ${input.buyerId} не існує`);

    // Доступний баланс = дозрілі нарахування − усі списання. pending не рахуються:
    // бали, які ще не дозріли, витратити не можна.
    const [{ balance }] = await sql<{ balance: string }>(
      manager,
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'earned' AND status = 'available'), 0)
            - COALESCE(SUM(amount) FILTER (WHERE kind = 'spent'), 0) AS balance
         FROM points_entries
        WHERE user_id = $1`,
      [input.buyerId],
    );
    if (Number(balance) < pointsSpent) {
      throw new CheckoutError('insufficient_points', `доступно ${balance} балів, потрібно ${pointsSpent}`);
    }
  }

  // ── 4. замовлення ────────────────────────────────────────────────────────
  let orderId: string;
  let placedAt: Date;
  try {
    const [order] = await sql<{ id: string; created_at: Date }>(
      manager,
      `INSERT INTO orders (buyer_id, device_id, region, status, currency, subtotal_cents, discount_cents, total_cents, points_spent, promo_code_id)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9)
       RETURNING id, created_at`,
      [input.buyerId, input.deviceId ?? null, region, ORDER_CURRENCY, subtotalCents, discountCents, totalCents, pointsSpent, promoCodeId],
    );
    orderId = order.id;
    placedAt = order.created_at;
  } catch (err) {
    // «Промокод раз на користувача» тримає partial unique index, а не if:
    // паралельний INSERT із тією ж парою чекає на коміт першого й падає тут.
    if (pgErrorField(err, 'constraint') === 'one_code_per_user') {
      throw new CheckoutError('promo_code_used', `промокод «${input.promoCode}» уже використано цим покупцем`);
    }
    if (pgErrorField(err, 'code') === PG_ERROR.FOREIGN_KEY_VIOLATION) {
      throw new CheckoutError('unknown_buyer', `покупця ${input.buyerId} не існує`);
    }
    throw err;
  }

  const params: unknown[] = [orderId];
  const tuples = priced.map(
    (l) => `($1, $${params.push(l.productId)}, $${params.push(l.qty)}, $${params.push(l.unitPriceCents)}, $${params.push(l.discountCents)}, $${params.push(l.promotionId)})`,
  );
  await sql(
    manager,
    `INSERT INTO order_items (order_id, product_id, qty, unit_price_cents, discount_cents, promotion_id) VALUES ${tuples.join(', ')}`,
    params,
  );

  if (pointsSpent > 0) {
    await sql(
      manager,
      `INSERT INTO points_entries (user_id, order_id, kind, amount, status, matures_at)
       VALUES ($1, $2, 'spent', $3, 'spent', NULL)`,
      [input.buyerId, orderId, pointsSpent],
    );
  }

  // ── 5. задача на чек — у тій самій транзакції ────────────────────────────
  // Лист не шлемо звідси: SMTP посеред транзакції тримав би локи stock на час
  // мережевого виклику, а відкат після відправленого листа неможливий.
  const [job] = await sql<{ id: string }>(
    manager,
    `INSERT INTO jobs (kind, payload) VALUES ('order_receipt', jsonb_build_object('orderId', $1::text)) RETURNING id`,
    [orderId],
  );

  const placed: CheckoutResult = {
    orderId,
    jobId: job.id,
    buyerId: input.buyerId,
    currency: ORDER_CURRENCY,
    placedAt: placedAt.toISOString(),
    lines: input.lines,
    subtotalCents,
    discountCents,
    totalCents,
    pointsSpent,
    amountDueCents: totalCents - pointsSpent * POINT_VALUE_CENTS,
  };

  // ── 6. подія — у тій самій транзакції (transactional outbox, #22) ────────
  // Не publish: брокер не вміє відкочуватись, і подія, відправлена звідси,
  // пережила б ROLLBACK. Рядок outbox — звичайний INSERT: комітиться з
  // замовленням або зникає разом із ним. id = eventId (UUID v5 від orderId) —
  // друга подія про те саме замовлення впреться в PK.
  const event = toOrderPlacedEvent(placed);
  await sql(
    manager,
    `INSERT INTO outbox (id, aggregate_type, aggregate_id, type, payload) VALUES ($1, $2, $3, $4, $5)`,
    [event.eventId, ORDER_AGGREGATE, orderId, event.type, JSON.stringify(event)],
  );

  // ── 7. ключ ідемпотентності — останнім ───────────────────────────────────
  // Останнім, бо order_id відомий лише тут. Ціна: паралельний дубль ключа
  // проходить усю транзакцію й відкочується на цьому рядку — один зайвий
  // ROLLBACK, але ніколи друге замовлення. Конкурентний INSERT із тим самим
  // ключем чекає на COMMIT першого й отримує конфлікт, а не другий рядок.
  //
  // DO UPDATE … WHERE — лише для простроченого ключа: через 24 години той
  // самий ключ створює нове замовлення (спека), а рядок перезаписується. Живий
  // ключ WHERE не пропускає, і RETURNING повертає 0 рядків.
  if (options.idempotency) {
    const [claimed] = await sql<{ key: string }>(
      manager,
      `INSERT INTO idempotency_keys (key, fingerprint, order_id) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
             SET fingerprint = EXCLUDED.fingerprint, order_id = EXCLUDED.order_id, created_at = now()
           WHERE idempotency_keys.created_at <= now() - make_interval(hours => $4)
       RETURNING key`,
      [options.idempotency.key, options.idempotency.fingerprint, orderId, IDEMPOTENCY_TTL_HOURS],
    );
    if (!claimed) throw new IdempotencyKeyTaken(options.idempotency.key);
  }

  await options.beforeCommit?.(manager, placed);
  return placed;
}
