import { randomUUID, type KeyObject } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { errors, jwtVerify, SignJWT, type JWTHeaderParameters, type JWTPayload } from 'jose';
import { USER_ROLES, type UserRole } from '../entities/user.entity';
import { ACCESS_ALG, AuthKeys } from './keys';

/**
 * Скільки живе access-токен. Це і є вікно, протягом якого вкрадений токен
 * працює, якщо його ніхто не відкликав, — і верхня межа життя запису в
 * денилисті. Коротше — частіші рефреші; довше — довше живе крадене.
 */
export const ACCESS_TTL_SECONDS = 10 * 60;

/** Хто видав і для кого. Перевіряються обидва: токен іншого сервісу з тим самим ключем тут не пройде. */
const ISSUER = 'marketplace-api';
const AUDIENCE = 'marketplace-api';
/** RFC 9068: `typ` відрізняє access-токен від будь-якого іншого JWT, підписаного тим самим ключем. */
const TYP = 'at+jwt';

/**
 * Хто прийшов — ФАКТ, перевірений підписом. `role` — кеш на момент видачі,
 * а не джерело правди: рішення «чи можна» ухвалює RolesGuard і сервіси.
 */
export interface Principal {
  userId: string;
  role: UserRole;
  /** Ідентифікатор саме цього токена — ним його відкликає логаут. */
  jti: string;
  /** Сімʼя refresh-токенів, з якої виписано токен, — один логін. */
  familyId: string;
  /** exp у секундах epoch: звідси TTL запису в денилисті. */
  expiresAt: number;
}

export interface IssuedAccess {
  token: string;
  jti: string;
  expiresIn: number;
}

/** Чому токен не прийнято — для `detail` у 401. Самого токена тут немає. */
export class InvalidAccessToken extends Error {}

function isRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

@Injectable()
export class AccessTokens {
  constructor(private readonly keys: AuthKeys) {}

  async issue(user: { id: string; role: UserRole }, familyId: string): Promise<IssuedAccess> {
    const jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ role: user.role, fid: familyId })
      .setProtectedHeader({ alg: ACCESS_ALG, kid: this.keys.signing.kid, typ: TYP })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(user.id)
      .setJti(jti)
      .setIssuedAt(now)
      .setExpirationTime(now + ACCESS_TTL_SECONDS)
      .sign(this.keys.signing.key);
    return { token, jti, expiresIn: ACCESS_TTL_SECONDS };
  }

  /**
   * Перевірка, а не decode. Підпис, exp, iss, aud і typ перевіряє jose;
   * відкликання (денилист) — не її справа, це робить AuthGuard.
   *
   * `algorithms` — явний allowlist, і це головний рядок файла. Без нього
   * бібліотека бере алгоритм із заголовка токена, тобто з рук атакувальника:
   * `alg: none` чи HS256, підписаний публічним ключем як секретом (algorithm
   * confusion). RFC 8725 §3.1 вимагає саме цього. Ключ до того ж обирається
   * за `kid` із фіксованого набору, а не з того, що прийшло в токені.
   */
  async verify(token: string): Promise<Principal> {
    const { sub, jti, exp, role, fid } = await this.verifiedClaims(token);
    if (typeof sub !== 'string' || typeof jti !== 'string' || typeof exp !== 'number' || typeof fid !== 'string' || !isRole(role)) {
      throw new InvalidAccessToken('у токені бракує sub, jti, exp, fid або role');
    }
    return { userId: sub, role, jti, familyId: fid, expiresAt: exp };
  }

  private async verifiedClaims(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, (header: JWTHeaderParameters) => this.keyFor(header), {
        algorithms: [ACCESS_ALG],
        issuer: ISSUER,
        audience: AUDIENCE,
        typ: TYP,
        requiredClaims: ['sub', 'jti', 'exp', 'iat'],
      });
      return payload;
    } catch (err) {
      throw new InvalidAccessToken(reasonOf(err));
    }
  }

  private keyFor(header: JWTHeaderParameters): KeyObject {
    const key = header.kid === undefined ? undefined : this.keys.verification.get(header.kid);
    if (!key) throw new InvalidAccessToken(`невідомий kid ${JSON.stringify(header.kid ?? null)}`);
    return key;
  }
}

/** Причина відмови людською мовою. Коди jose стабільні, текст — ні. */
function reasonOf(err: unknown): string {
  if (err instanceof InvalidAccessToken) return err.message;
  if (err instanceof errors.JWTExpired) return 'токен протух';
  if (err instanceof errors.JWSSignatureVerificationFailed) return 'підпис не сходиться';
  if (err instanceof errors.JOSEAlgNotAllowed) return 'алгоритм підпису не дозволено';
  if (err instanceof errors.JWTClaimValidationFailed) return `claim ${err.claim}: ${err.reason}`;
  return 'токен не розбирається як JWS';
}
