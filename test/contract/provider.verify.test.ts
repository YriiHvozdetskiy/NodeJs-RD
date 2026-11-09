import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { RequestHandler } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Verifier, type VerifierOptions } from '@pact-foundation/pact';
import { AccessTokens } from '../../src/auth/access-tokens';
import { bootApp } from '../testkit/app';
import { startPostgres, type TestPostgres } from '../testkit/postgres';
import { PACT_FILE, PROVIDER, providerBranch, providerVersion } from './pact.config';
import { PACT_BUYER_ID, providerStates } from './provider-states';

/**
 * Звідки брати контракт — вирішує оточення, а не прапорець у коді:
 *   • PACT_BROKER_URL не задано → локальний pacts/*.json після `npm run test:contract`;
 *   • задано → контракт із брокера, і результат верифікації публікується назад,
 *     під версією провайдера (коміт). Саме на цю версію потім лягає тег prod.
 * Адреса й токен брокера — лише з process.env: локально їх кладе
 * scripts/with-secrets.sh зі сховища, у CI — secrets GitHub.
 */
function pactSource(): Partial<VerifierOptions> {
  const brokerUrl = process.env.PACT_BROKER_URL;
  if (!brokerUrl) {
    if (!existsSync(PACT_FILE)) throw new Error(`немає ${PACT_FILE} — спершу npm run test:contract`);
    return { pactUrls: [PACT_FILE] };
  }
  const token = process.env.PACT_BROKER_TOKEN;
  return {
    pactBrokerUrl: brokerUrl,
    ...(token ? { pactBrokerToken: token } : {}),
    consumerVersionSelectors: [{ latest: true }],
    publishVerificationResult: true,
    providerVersion: providerVersion(),
    providerVersionBranch: providerBranch(),
  };
}

/**
 * Токен у контракті — приклад консюмера, і підпис у нього, звісно, не наш:
 * AuthGuard відповів би 401 на кожну interaction. Тому верифаєр перед
 * кожним запитом підставляє справжній access-токен покупця з provider
 * states — виписаний тим самим AccessTokens застосунку, тим самим ключем.
 * Логін тут не потрібен: перевіряється контракт замовлень, а не вхід.
 *
 * Підміна лише там, де консюмер заголовок надіслав: запит без нього мусить
 * і далі отримувати 401, а не мовчки ставати автентифікованим.
 */
function asPactBuyer(tokens: AccessTokens): RequestHandler {
  return (req, _res, next) => {
    if (!req.headers.authorization) {
      next();
      return;
    }
    tokens.issue({ id: PACT_BUYER_ID, role: 'buyer' }, randomUUID()).then((issued) => {
      req.headers.authorization = `Bearer ${issued.token}`;
      next();
    }, next);
  };
}

describe('Pact provider · справжній marketplace-api проти контракту marketplace-web', () => {
  let pg: TestPostgres;
  let app: NestExpressApplication;
  let baseUrl: string;
  let source: Partial<VerifierOptions>;

  beforeAll(async () => {
    // Спершу — чи є що верифікувати: без контракту немає сенсу піднімати базу.
    source = pactSource();
    pg = await startPostgres();
    app = await bootApp(pg);
    // Верифаєр — окремий процес (Rust-ядро Pact), він ходить справжнім HTTP.
    // supertest тут не підходить: потрібен listen на реальному порту.
    await app.listen(0, '127.0.0.1');
    // /v1 — це `servers.url` спеки. Шляхи в контракті, як і в спеці, без версії.
    baseUrl = `${await app.getUrl()}/v1`;
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  test('кожна interaction контракту проходить на справжньому застосунку з Postgres', async () => {
    const report = await new Verifier({
      provider: PROVIDER,
      providerBaseUrl: baseUrl,
      stateHandlers: providerStates(pg.pool),
      requestFilter: asPactBuyer(app.get(AccessTokens)),
      logLevel: 'warn',
      ...source,
    }).verifyProvider();

    // Людський звіт («has a matching body (OK)») ядро Pact друкує саме, у
    // stdout процесу. Тут — той самий звіт у JSON, з "result":"OK" на кожну
    // interaction: його зручно грепати в CI без зняття ANSI-кольорів.
    console.log(report);
  });
});
