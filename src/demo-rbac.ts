import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { requiredEnv } from './db/cli-env';
import { call, cleanup, createUser, detailOf, login, tamper, tokensOf, type Reply } from './auth/demo-kit';
import { Summary } from './messaging/demo-kit';
import { migrateSchema, startApi, type Api } from './redis/demo-kit';

/**
 * demo:rbac — пункти 5–6 ДЗ #24: 401 ≠ 403, власність, роль і справжня
 * перевірка підпису.
 *
 *   GET  /orders/{A}  без токена               → 401   хто це? — невідомо
 *   GET  /orders/{A}  токен покупця A          → 200   власник
 *   GET  /orders/{A}  токен покупця B          → 403   особа відома, замовлення чуже
 *   POST /products    токен покупця            → 403   роль не та
 *   POST /products    токен продавця           → 201   роль та
 *   POST /products    токен A з role=admin,    → 401   payload підмінено, підпис старий:
 *                     підпис старий                    рішення на jwt.decode() дало б 201
 *
 * Перша пара — розділення двох дисциплін: «хто це» (401, клієнт рефрешить) і
 * «чи можна» (403, клієнт показує помилку). Власність — не гард: її перевіряє
 * сервіс, коли замовлення вже прочитане (src/orders/orders.service.ts).
 */
const DEMO = 'rbac';

const NEW_PRODUCT = { title: 'Демо-товар RBAC', category: 'books', price_cents: 10_000, stock: 1 };

async function main(): Promise<void> {
  const summary = new Summary();
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  let api: Api | undefined;

  try {
    await migrateSchema();
    await cleanup(dataSource, DEMO);
    const [owner, stranger, seller] = await Promise.all([
      createUser(dataSource, DEMO, 'owner', 'buyer'),
      createUser(dataSource, DEMO, 'stranger', 'buyer'),
      createUser(dataSource, DEMO, 'seller', 'seller'),
    ]);
    const orderId = await orderOf(dataSource, owner.id, seller.id);
    api = await startApi();
    console.log(`── demo:rbac: замовлення ${orderId} покупця ${owner.email}, застосунок на ${api.url} ──`);

    const step = (key: string, reply: Reply): number => {
      summary.line(key, reply.status);
      const detail = detailOf(reply);
      if (detail) console.log(`   ${key}: ${detail}`);
      return reply.status;
    };

    const [ownerTokens, strangerTokens, sellerTokens] = (await Promise.all([login(api, owner), login(api, stranger), login(api, seller)])).map(
      tokensOf,
    );

    const statusAnon = step('anon', await call(api, 'GET', `/orders/${orderId}`));
    const statusOwn = step('own', await call(api, 'GET', `/orders/${orderId}`, { token: ownerTokens.access }));
    const statusForeign = step('foreign', await call(api, 'GET', `/orders/${orderId}`, { token: strangerTokens.access }));
    const statusDenied = step('role-denied', await call(api, 'POST', '/products', { token: ownerTokens.access, body: NEW_PRODUCT }));
    const statusAllowed = step('role-allowed', await call(api, 'POST', '/products', { token: sellerTokens.access, body: NEW_PRODUCT }));
    const statusTampered = step(
      'tampered',
      await call(api, 'POST', '/products', { token: tamper(ownerTokens.access, { role: 'admin' }), body: NEW_PRODUCT }),
    );

    // Понад контракт — дві класичні атаки на алгоритм, від яких захищає
    // явний `algorithms: ['ES256']` у перевірці (src/auth/access-tokens.ts):
    //   alg-none        — заголовок alg: none і порожній підпис;
    //   alg-confusion   — HS256, де «секретом» узято ПУБЛІЧНИЙ ключ сервера:
    //                     бібліотека, що вірить alg із токена, перевірила б
    //                     HMAC тим самим публічним ключем — і погодилась.
    const statusNone = step('alg-none', await call(api, 'POST', '/products', { token: algNone(ownerTokens.access), body: NEW_PRODUCT }));
    const statusConfusion = step(
      'alg-confusion',
      await call(api, 'POST', '/products', { token: hs256WithPublicKey(ownerTokens.access), body: NEW_PRODUCT }),
    );

    summary.expect('anon=401 — без токена особа невідома', statusAnon === 401);
    summary.expect('own=200 — власник бачить своє замовлення', statusOwn === 200);
    summary.expect('foreign=403 — особа відома, але замовлення чуже', statusForeign === 403);
    summary.expect('role-denied=403 — покупцю запис у каталог заборонено', statusDenied === 403);
    summary.expect('role-allowed=201 — продавцю дозволено', statusAllowed === 201);
    summary.expect('tampered=401 — підпис перевіряється, а не decode-иться', statusTampered === 401);
    summary.expect('alg-none=401', statusNone === 401);
    summary.expect('alg-confusion=401', statusConfusion === 401);
  } finally {
    await api?.close();
    await cleanup(dataSource, DEMO).catch(() => undefined);
    await dataSource.destroy();
  }
  summary.finish();
}

/**
 * Замовлення покупця на товар продавця — напряму SQL-ом, як builder у тестах:
 * це arrange-фаза, і їй не потрібні ні checkout, ні outbox.
 */
async function orderOf(dataSource: DataSource, buyerId: string, sellerId: string): Promise<string> {
  const price = 25_000;
  const [product]: { id: string }[] = await dataSource.query(
    `INSERT INTO products (seller_id, category, title, price_cents, stock) VALUES ($1, 'books', 'Демо-книга RBAC', $2, 5) RETURNING id`,
    [sellerId, price],
  );
  const [order]: { id: string }[] = await dataSource.query(
    `INSERT INTO orders (buyer_id, region, status, currency, subtotal_cents, discount_cents, total_cents)
     VALUES ($1, 'UA', 'pending', 'UAH', $2, 0, $2) RETURNING id`,
    [buyerId, price],
  );
  await dataSource.query(`INSERT INTO order_items (order_id, product_id, qty, unit_price_cents) VALUES ($1, $2, 1, $3)`, [
    order.id,
    product.id,
    price,
  ]);
  return order.id;
}

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function payloadOf(token: string): Record<string, unknown> {
  return { ...JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()), role: 'admin' };
}

function headerOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString());
}

function algNone(token: string): string {
  return `${b64url({ ...headerOf(token), alg: 'none' })}.${b64url(payloadOf(token))}.`;
}

function hs256WithPublicKey(token: string): string {
  const signingInput = `${b64url({ ...headerOf(token), alg: 'HS256' })}.${b64url(payloadOf(token))}`;
  const publicPem = Buffer.from(requiredEnv('JWT_PUBLIC_KEY'), 'base64').toString('utf8');
  return `${signingInput}.${createHmac('sha256', publicPem).update(signingInput).digest('base64url')}`;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
