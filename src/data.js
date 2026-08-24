'use strict';

const { HttpProblem } = require('./problem');

// In-memory дані. На #12 це стане схемою Postgres, на #13 — TypeORM-entities.
// Важливе вже зараз: порядок сортування — (created_at DESC, id DESC), рівно той,
// на який спирається keyset-курсор. Змінити його = зламати всі видані курсори.
//
// Товари 4 і 5 мають ОДНАКОВИЙ created_at навмисно: без id у курсорі один із них
// назавжди зникав би між сторінками.
const PRODUCTS = [
  { id: 1, title: 'Клавіатура Keychron K2',   price_cents: 260000, currency: 'UAH', created_at: '2026-08-01T10:00:00.000Z' },
  { id: 2, title: 'Мишка Logitech MX Master', price_cents: 380000, currency: 'UAH', created_at: '2026-08-02T10:00:00.000Z' },
  { id: 3, title: 'Килимок Razer Goliathus',  price_cents:  45000, currency: 'UAH', created_at: '2026-08-03T10:00:00.000Z' },
  { id: 4, title: 'Монітор Dell U2723QE',     price_cents: 2150000, currency: 'UAH', created_at: '2026-08-04T10:00:00.000Z' },
  { id: 5, title: 'USB-C хаб Anker 555',      price_cents: 320000, currency: 'UAH', created_at: '2026-08-04T10:00:00.000Z' },
  { id: 6, title: 'Навушники Sony WH-1000XM5', price_cents: 1450000, currency: 'UAH', created_at: '2026-08-05T10:00:00.000Z' },
  { id: 7, title: 'Веб-камера Logitech Brio',  price_cents: 690000, currency: 'UAH', created_at: '2026-08-06T10:00:00.000Z' },
];

const ORDERS = [
  { id: 1, items: [{ product_id: 1, qty: 1, unit_price_cents: 260000 }], total_cents: 260000, currency: 'UAH', status: 'paid',      created_at: '2026-08-10T09:00:00.000Z' },
  { id: 2, items: [{ product_id: 3, qty: 2, unit_price_cents: 45000 }],  total_cents:  90000, currency: 'UAH', status: 'pending',   created_at: '2026-08-11T09:00:00.000Z' },
  { id: 3, items: [{ product_id: 4, qty: 1, unit_price_cents: 2150000 }], total_cents: 2150000, currency: 'UAH', status: 'cancelled', created_at: '2026-08-12T09:00:00.000Z' },
  { id: 4, items: [{ product_id: 2, qty: 1, unit_price_cents: 380000 }, { product_id: 3, qty: 1, unit_price_cents: 45000 }], total_cents: 425000, currency: 'UAH', status: 'paid', created_at: '2026-08-13T09:00:00.000Z' },
  { id: 5, items: [{ product_id: 6, qty: 1, unit_price_cents: 1450000 }], total_cents: 1450000, currency: 'UAH', status: 'pending', created_at: '2026-08-14T09:00:00.000Z' },
];

let nextOrderId = ORDERS.length + 1;

// Найновіші спершу; id — tie-breaker, той самий, що всередині курсора.
const newestFirst = (a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1);

const products = () => [...PRODUCTS].sort(newestFirst);
const orders = () => [...ORDERS].sort(newestFirst);
const findProduct = (id) => PRODUCTS.find((p) => p.id === id);
const findOrder = (id) => ORDERS.find((o) => o.id === id);

function createOrder(items) {
  const lines = items.map((line) => {
    const product = findProduct(line.product_id);
    if (!product) {
      // Тіло синтаксично валідне (валідатор його пропустив), але опрацювати
      // не можна — це рівно те, для чого існує 422, а не 400.
      throw new HttpProblem(422, `товару ${line.product_id} немає в каталозі`, { code: 'unknown-product' });
    }
    // Ціну КОПІЮЄМО в замовлення. Читати її з каталогу під час показу означало б
    // переписувати історію вже оплачених замовлень при кожній зміні цінника.
    return { product_id: product.id, qty: line.qty, unit_price_cents: product.price_cents };
  });

  const order = {
    id: nextOrderId++,
    items: lines,
    // Цілі копійки: множення й додавання лишаються в integer, тож 0.1 + 0.2
    // тут неможливе за побудовою.
    total_cents: lines.reduce((sum, l) => sum + l.unit_price_cents * l.qty, 0),
    currency: 'UAH',
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  ORDERS.push(order);
  return order;
}

module.exports = { products, orders, findProduct, findOrder, createOrder };
