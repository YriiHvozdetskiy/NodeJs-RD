import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import { ApiProblem, MarketplaceClient } from './marketplace-client';
import { CONSUMER, PACT_DIR, PROVIDER, STATE } from './pact.config';

const { eachLike, integer, iso8601DateTimeWithMillis, like, regex } = MatchersV3;

/**
 * Pact consumer: marketplace-web записує, чого чекає від marketplace-api.
 * Pact піднімає мок-сервер з цього опису, клієнт фронтенду ходить у нього як
 * у справжній API, а результат — pacts/marketplace-web-marketplace-api.json.
 *
 * Матчери замість точних значень там, де значення — властивість даних, а не
 * контракту: id, ціни, дата. Точно зафіксовано лише те, на чому клієнт
 * будує логіку: `currency` (enum спеки), `status` нового замовлення, `type`
 * помилки.
 */
const provider = new PactV3({ consumer: CONSUMER, provider: PROVIDER, dir: PACT_DIR, logLevel: 'error' });

// Regex заголовка Pact звіряє з УСІМ значенням, а не з початком: без `.*`
// значення `application/json; charset=utf-8` не пройшло б.
const JSON_TYPE = regex('application/json.*', 'application/json; charset=utf-8');
const PROBLEM_TYPE = regex('application/problem\\+json.*', 'application/problem+json; charset=utf-8');

const orderLine = { product_id: integer(501), qty: integer(2), unit_price_cents: integer(260_000) };

describe('Pact consumer · marketplace-web → marketplace-api', () => {
  test('GET /orders/{orderId}: замовлення, яке існує', async () => {
    provider
      .given(STATE.orderExists)
      .uponReceiving('запит наявного замовлення 1001')
      .withRequest({ method: 'GET', path: '/orders/1001', headers: { Accept: 'application/json' } })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': JSON_TYPE },
        body: {
          id: integer(1001),
          items: eachLike(orderLine),
          total_cents: integer(520_000),
          currency: 'UAH',
          status: regex('^(pending|paid|cancelled)$', 'paid'),
          created_at: iso8601DateTimeWithMillis('2026-09-30T10:00:00.000Z'),
        },
      });

    await provider.executeTest(async (mock) => {
      const order = await new MarketplaceClient(mock.url).getOrder(1001);

      expect(order.id).toBe(1001);
      expect(order.items[0]).toEqual({ product_id: 501, qty: 2, unit_price_cents: 260_000 });
    });
  });

  test('POST /orders: оформлення з Idempotency-Key → 201 і Location', async () => {
    provider
      .given(STATE.productInStock)
      .uponReceiving('оформлення замовлення на 2 × товар 501')
      .withRequest({
        method: 'POST',
        path: '/orders',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'pact-7f3c1d2e-8a44-4b90' },
        body: { items: [{ product_id: 501, qty: 2 }] },
      })
      .willRespondWith({
        status: 201,
        headers: { 'Content-Type': JSON_TYPE, Location: regex('^/v1/orders/\\d+$', '/v1/orders/1') },
        body: {
          id: integer(1),
          items: eachLike(orderLine),
          total_cents: integer(520_000),
          currency: 'UAH',
          // v1 створює замовлення лише в pending — це частина контракту.
          status: 'pending',
          created_at: iso8601DateTimeWithMillis('2026-09-30T10:00:00.000Z'),
        },
      });

    await provider.executeTest(async (mock) => {
      const { order, location } = await new MarketplaceClient(mock.url).createOrder(
        [{ product_id: 501, qty: 2 }],
        'pact-7f3c1d2e-8a44-4b90',
      );

      expect(order.status).toBe('pending');
      expect(location).toBe(`/v1/orders/${order.id}`);
    });
  });

  test('GET /orders/{orderId}: замовлення немає → 404 problem+json із type not-found', async () => {
    provider
      .given(STATE.orderMissing)
      .uponReceiving('запит замовлення, якого немає')
      .withRequest({ method: 'GET', path: '/orders/999999', headers: { Accept: 'application/json' } })
      .willRespondWith({
        status: 404,
        headers: { 'Content-Type': PROBLEM_TYPE },
        body: {
          type: 'https://api.marketplace.example/problems/not-found',
          title: like('Ресурс не знайдено'),
          status: 404,
          detail: like('замовлення 999999 не існує'),
          instance: like('/v1/orders/999999'),
        },
      });

    await provider.executeTest(async (mock) => {
      const failure = await new MarketplaceClient(mock.url).getOrder(999_999).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(ApiProblem);
      expect(failure).toMatchObject({ type: 'https://api.marketplace.example/problems/not-found', status: 404 });
    });
  });
});
