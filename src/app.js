'use strict';

const path = require('node:path');
const express = require('express');
const { middleware: openApiValidator } = require('express-openapi-validator');

const { HttpProblem, toProblem } = require('./problem');
const { paginate } = require('./cursor');
const data = require('./data');
const idem = require('./idempotency');

const SPEC = path.join(__dirname, '..', 'openapi', 'openapi.yaml');
// Версія живе в servers.url спеки, тому й тут вона — префікс монтування,
// а не частина шляху ресурсу.
const BASE = '/v1';

const app = express();
app.use(express.json());

app.use(
  openApiValidator({
    apiSpec: SPEC,
    validateRequests: true,
    // ОСЬ ТОЙ, ХТО ЗВІРЯЄ. Без цього рядка спека — красивий файл: сервер міг би
    // віддати totalCents замість total_cents, і нічого всередині не помітило б.
    validateResponses: true,
  }),
);

// DRIFT=1 — «невинний рефакторинг»: camelCase замість snake_case, currency
// загубили, спеку не чіпали. Рівно те, що на лекції ловив contract/check.mjs.
function orderView(order) {
  if (process.env.DRIFT !== '1') return order;
  const { total_cents, currency, ...rest } = order;
  return { ...rest, totalCents: total_cents };
}

const readLimit = (req) => Number(req.query.limit ?? 20);

// express@4 не ловить відхилені промайси в обробниках (express@5 уже вміє).
// Без цієї обгортки async-помилка стала б unhandledRejection і вбила процес.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get(`${BASE}/products`, (req, res) => {
  res.json(paginate(data.products(), { limit: readLimit(req), cursor: req.query.cursor }));
});

app.get(`${BASE}/products/:productId`, (req, res) => {
  const product = data.findProduct(Number(req.params.productId));
  if (!product) throw new HttpProblem(404, `товару ${req.params.productId} не існує`);
  res.json(product);
});

app.get(`${BASE}/orders`, (req, res) => {
  const page = paginate(data.orders(), { limit: readLimit(req), cursor: req.query.cursor });
  res.json({ ...page, items: page.items.map(orderView) });
});

app.get(`${BASE}/orders/:orderId`, (req, res) => {
  const order = data.findOrder(Number(req.params.orderId));
  if (!order) throw new HttpProblem(404, `замовлення ${req.params.orderId} не існує`);
  res.json(orderView(order));
});

app.post(`${BASE}/orders`, wrap(async (req, res) => {
  // Наявність заголовка й довжину вже гарантувала спека — жодного `if` тут не
  // треба. Це і є сенс пункту 5: вимогу тримає контракт, а не код.
  const key = req.get('Idempotency-Key');
  const fp = idem.fingerprint(req.body);
  const entry = idem.get(key);

  switch (idem.decide(entry, fp)) {
    case 'in-flight':
      throw new HttpProblem(409, `запит із цим Idempotency-Key ще опрацьовується`, {
        code: 'idempotency-key-in-flight',
      });
    case 'mismatch':
      throw new HttpProblem(422, 'цей Idempotency-Key вже використано з іншим тілом запиту', {
        code: 'idempotency-key-reused',
      });
    case 'replay':
      // Обробник НЕ виконується — у цьому вся гарантія. Другого замовлення
      // й другого списання не буде.
      res.setHeader('Idempotency-Replay', 'true');
      res.setHeader('Location', `${BASE}/orders/${entry.response.id}`);
      return res.status(201).json(orderView(entry.response));
  }

  idem.markInFlight(key, fp);
  try {
    // SLOW_MS імітує те, чим на #14 стане транзакція в Postgres: обробник
    // віддає event loop, і саме в цьому вікні другий запит із тим самим ключем
    // бачить стан 'in-flight'. Без затримки гілка 409 недосяжна фізично —
    // синхронний обробник ніколи не переривається.
    const delay = Number(process.env.SLOW_MS ?? 0);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

    const order = data.createOrder(req.body.items);
    idem.markDone(key, fp, order);
    res.setHeader('Location', `${BASE}/orders/${order.id}`);
    res.status(201).json(orderView(order));
  } catch (err) {
    idem.forget(key);
    throw err;
  }
}));

// Одна точка на всі помилки — і валідатора, і наші власні, і невідомі шляхи
// (їх відхиляє сам валідатор, бо їх немає у спеці).
app.use((err, req, res, _next) => {
  const problem = toProblem(err, req);
  res.status(problem.status).type('application/problem+json').json(problem);
});

module.exports = app;
