import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

/**
 * Єдиний алгоритм, який сервіс підписує і ПРИЙМАЄ. ES256 — ECDSA на P-256 з
 * SHA-256 (RFC 7518 §3.4). Асиметричний: перевірити токен може будь-хто з
 * публічним ключем, а виписати — лише власник приватного.
 */
export const ACCESS_ALG = 'ES256';

export interface SigningKey {
  kid: string;
  key: KeyObject;
}

/** `base64(PEM)` зі сховища → PEM. Формат ключа вже перевірила zod-схема. */
function pemOf(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Відбиток ключа — перші 16 hex від SHA-256 його публічної половини (DER).
 * Прийом із #11: у лог і в README іде відбиток, а не значення. За ним видно,
 * ЯКИЙ ключ стоїть у процесі, і нічого не можна відновити.
 */
export function fingerprint(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/**
 * Ключі одного процесу: одна пара підписує, а набір публічних ключів перевіряє.
 *
 * Набір — Map за `kid`, бо під час overlap-ротації в ньому дві публічні
 * половини: нова і попередня. Токен каже `kid` у заголовку, і перевірка бере
 * рівно той ключ. Невідомий `kid` — 401, без перебору всіх ключів підряд.
 *
 * KeyObject, а не PEM-рядок: PEM розбирається один раз на старті, а не на
 * кожен запит, і помилка формату вбиває процес тут, а не на першому логіні.
 */
export class AuthKeys {
  private static readonly logger = new Logger('JWT');

  constructor(
    readonly signing: SigningKey,
    readonly verification: ReadonlyMap<string, KeyObject>,
  ) {}

  static fromConfig(config: ConfigService<Env, true>): AuthKeys {
    const kid = config.get('JWT_KID', { infer: true });
    const signing: SigningKey = { kid, key: createPrivateKey(pemOf(config.get('JWT_PRIVATE_KEY', { infer: true }))) };
    const verification = new Map<string, KeyObject>([[kid, createPublicKey(pemOf(config.get('JWT_PUBLIC_KEY', { infer: true })))]]);

    const previousKid = config.get('JWT_PREVIOUS_KID', { infer: true });
    const previousKey = config.get('JWT_PREVIOUS_PUBLIC_KEY', { infer: true });
    // Не `!== undefined`: ConfigService віддає сире значення з process.env, і
    // порожній рядок, який zod звів до «немає», сюди доходить як ''.
    if (previousKid && previousKey) {
      verification.set(previousKid, createPublicKey(pemOf(previousKey)));
    }

    const keys = new AuthKeys(signing, verification);
    const verifying = [...verification].map(([id, key]) => `${id} (${fingerprint(key)})`).join(', ');
    AuthKeys.logger.log(`${ACCESS_ALG}: підписує ${kid} (${fingerprint(signing.key)}); перевіряються ${verifying}`);
    return keys;
  }
}
