import type { Pool } from 'pg';
import { STATE } from './pact.config';

/**
 * «given» з контракту → рядки в БД провайдера.
 *
 * Id фіксовані, бо їх знає контракт (`/orders/1001`), тому `OVERRIDING SYSTEM
 * VALUE` — колонки `GENERATED ALWAYS` інакше id ззовні не приймають. Лічильник
 * identity від цього не зсувається: замовлення, яке створить POST з контракту,
 * отримає id 1, а не зіткнеться з 1001.
 *
 * `ON CONFLICT DO NOTHING` — щоб обробник можна було викликати скільки завгодно
 * разів: верифаєр кличе його перед КОЖНОЮ interaction зі своїм станом, а
 * `order 1001 exists` спирається ще й на товар із `product 501 is in stock`.
 */
async function seedProduct501(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO users (id, email, password_hash, role) OVERRIDING SYSTEM VALUE
    VALUES (9001, 'seller-9001@pact.local', '!', 'seller')
    ON CONFLICT DO NOTHING;

    INSERT INTO products (id, seller_id, category, title, price_cents, stock) OVERRIDING SYSTEM VALUE
    VALUES (501, 9001, 'electronics', 'Клавіатура Keychron K2', 260000, 100)
    ON CONFLICT DO NOTHING;
  `);
}

async function seedOrder1001(pool: Pool): Promise<void> {
  await seedProduct501(pool);
  await pool.query(`
    INSERT INTO users (id, email, password_hash, role) OVERRIDING SYSTEM VALUE
    VALUES (9002, 'buyer-9002@pact.local', '!', 'buyer')
    ON CONFLICT DO NOTHING;

    INSERT INTO orders (id, buyer_id, region, status, currency, subtotal_cents, discount_cents, total_cents, created_at)
    OVERRIDING SYSTEM VALUE
    VALUES (1001, 9002, 'UA', 'paid', 'UAH', 520000, 0, 520000, '2026-09-30T10:00:00Z')
    ON CONFLICT DO NOTHING;

    INSERT INTO order_items (order_id, product_id, qty, unit_price_cents)
    VALUES (1001, 501, 2, 260000)
    ON CONFLICT DO NOTHING;
  `);
}

export function providerStates(pool: Pool): Record<string, () => Promise<void>> {
  return {
    [STATE.productInStock]: () => seedProduct501(pool),
    [STATE.orderExists]: () => seedOrder1001(pool),
    // Сідити нічого: 999999 не видає ні жоден стан вище, ні identity свіжого контейнера.
    [STATE.orderMissing]: async () => undefined,
  };
}
