import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/** Уявний фронтенд і цей сервіс — так вони називаються в контракті й у брокері. */
export const CONSUMER = 'marketplace-web';
export const PROVIDER = 'marketplace-api';

export const PACT_DIR = path.resolve('pacts');
export const PACT_FILE = path.join(PACT_DIR, `${CONSUMER}-${PROVIDER}.json`);

/**
 * Назви provider states — єдине, що консюмер і провайдер ділять, крім самого
 * контракту. Консюмер лише називає стан, як сідити під нього БД, знає тільки
 * провайдер (provider-states.ts).
 */
export const STATE = {
  orderExists: 'order 1001 exists',
  productInStock: 'product 501 is in stock',
  orderMissing: 'order 999999 does not exist',
} as const;

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/**
 * Версія провайдера для брокера — коміт, а не package.json: `0.1.0` означав
 * би однакову версію для різного коду, і брокер не зміг би їх розрізнити.
 * Той самий дефолт бере scripts/pact-broker.sh, коли ставить тег prod: тег
 * мусить лягти рівно на ту версію, яку опублікувала верифікація.
 */
export function providerVersion(): string {
  return process.env.PACT_PROVIDER_VERSION || git('rev-parse', '--short', 'HEAD');
}

export function providerBranch(): string | undefined {
  return process.env.PACT_BRANCH || git('branch', '--show-current') || undefined;
}
