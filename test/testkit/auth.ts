import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DenylistUnavailable, type AccessDenylist } from '../../src/auth/access-denylist';
import { ACCESS_TTL_SECONDS, type Principal } from '../../src/auth/access-tokens';
import type { Queryable } from '../../src/db/queryable';
import { aUser } from './builders';

/**
 * Секрети сховища (#24) для тестів: одноразова пара ES256 на процес jest і
 * випадковий перець. Той самий прийом, що в блоці Grading README: застосунку
 * байдуже, чия це пара, аби вона була валідна. Жодного ключа в репозиторії.
 */
let vault: Record<string, string> | undefined;

export function authEnv(): Record<string, string> {
  if (vault) return vault;
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  vault = {
    JWT_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
    JWT_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
    JWT_KID: 'test',
    REFRESH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
  };
  return vault;
}

/**
 * Денилист у памʼяті процесу — заміна Redis черги в тестах. Тести ходять без
 * Redis (REDIS_QUEUE_URL порожній, див. testkit/postgres.ts), а справжній
 * денилист без нього чесно відповідає 503 на кожен запит із токеном.
 * Семантика та сама: запис jti живе до exp токена, запис сімʼї —
 * ACCESS_TTL_SECONDS. Справжній денилист у Redis доводять demo:auth і demo:reuse.
 */
export class MemoryDenylist implements Pick<AccessDenylist, 'revoke' | 'revokeFamily' | 'isRevoked'> {
  private readonly until = new Map<string, number>();

  /**
   * «Запис до Redis не доходить» — так тест відтворює dual write, що впав на
   * другому кроці: читання працюють, записи кидають DenylistUnavailable, як
   * справжній денилист на помилці Redis.
   */
  writesFail = false;

  async revoke(principal: Principal): Promise<void> {
    this.write();
    this.until.set(`jti:${principal.jti}`, principal.expiresAt * 1000);
    await this.revokeFamily(principal.familyId);
  }

  async revokeFamily(familyId: string, ttlSeconds: number = ACCESS_TTL_SECONDS): Promise<void> {
    this.write();
    this.until.set(`fid:${familyId}`, Date.now() + ttlSeconds * 1000);
  }

  private write(): void {
    if (this.writesFail) throw new DenylistUnavailable('запис не дійшов (тест)');
  }

  async isRevoked(principal: Principal): Promise<boolean> {
    const now = Date.now();
    return [`jti:${principal.jti}`, `fid:${principal.familyId}`].some((key) => (this.until.get(key) ?? 0) > now);
  }
}

export interface LoggedIn {
  id: number;
  accessToken: string;
  refreshToken: string;
}

/**
 * Користувач зі справжнім паролем і справжнім логіном через POST /v1/auth/login:
 * токен, з яким тест іде далі, виписав сам застосунок, тим самим ключем і з
 * тим самим рядком у refresh_tokens, що й для живого клієнта.
 */
export async function loggedInUser(app: NestExpressApplication, db: Queryable, role: 'buyer' | 'seller' = 'buyer'): Promise<LoggedIn> {
  const password = randomBytes(12).toString('base64url');
  const builder = aUser().withPassword(password);
  const user = await (role === 'seller' ? builder.asSeller() : builder).insert(db);

  const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: user.email, password }).expect(200);
  return { id: user.id, accessToken: res.body.access_token, refreshToken: res.body.refresh_token };
}
