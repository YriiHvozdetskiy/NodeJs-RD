import { Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { RedisConnections } from '../redis/redis-connections';
import { ACCESS_TTL_SECONDS, type Principal } from './access-tokens';

/** Денилист недоступний: перевірити відкликання нічим — запит не пускаємо. */
export class DenylistUnavailable extends Error {}

export const jtiKey = (jti: string): string => `auth:deny:jti:${jti}`;
export const familyKey = (familyId: string): string => `auth:deny:fid:${familyId}`;

/**
 * Відкликані access-токени — у Redis ЧЕРГИ, не кешу. Кеш живе з
 * `allkeys-lru`: під тиском памʼяті він мовчки викидає ключі, і викинутий
 * запис денилиста — це відкликаний токен, що знову працює. Redis черги
 * стоїть на `noeviction`: тут запис зникає лише тоді, коли сплив його TTL.
 *
 * Два види записів, і кожен закриває своє:
 *   • `jti` — токен, з яким прийшли на логаут. TTL = залишок його життя:
 *     після exp його й так відкине перевірка підпису, тримати запис довше —
 *     лише рости сховищем;
 *   • `fid` — уся сімʼя: інші access-токени того самого логіна, чиїх jti
 *     сервер ніде не зберігав (виписані попередніми рефрешами, або токен
 *     злодія, коли спрацювала детекція повтору). TTL = ACCESS_TTL_SECONDS: будь-який
 *     токен сімʼї протухне раніше, ніж зникне запис.
 *
 * Помилка Redis тут не ковтається, на відміну від кешу: «не змогли
 * перевірити, чи відкликано» не означає «не відкликано». Fail closed — 503.
 */
@Injectable()
export class AccessDenylist {
  private readonly redis?: Redis;

  constructor(connections: RedisConnections) {
    this.redis = connections.queue;
  }

  /** Логаут: цей токен і всі токени його сімʼї. */
  async revoke(principal: Principal): Promise<void> {
    const remaining = principal.expiresAt - Math.floor(Date.now() / 1000);
    const redis = this.client();
    try {
      const tx = redis.multi().set(familyKey(principal.familyId), '1', 'EX', ACCESS_TTL_SECONDS);
      // Протухлий токен сюди не дійде (його відкинув би гард), але межа
      // секунди між гардом і цим рядком реальна: EX 0 Redis відхилив би.
      if (remaining > 0) tx.set(jtiKey(principal.jti), '1', 'EX', remaining);
      await tx.exec();
    } catch (err) {
      throw new DenylistUnavailable(err instanceof Error ? err.message : String(err));
    }
  }

  /** Детекція повтору: jti токена злодія невідомий, тож закриваємо сімʼю цілком. */
  async revokeFamily(familyId: string): Promise<void> {
    try {
      await this.client().set(familyKey(familyId), '1', 'EX', ACCESS_TTL_SECONDS);
    } catch (err) {
      throw new DenylistUnavailable(err instanceof Error ? err.message : String(err));
    }
  }

  /** Одна команда на обидва ключі: EXISTS повертає, скільки з них є. */
  async isRevoked(principal: Principal): Promise<boolean> {
    const redis = this.client();
    try {
      return (await redis.exists(jtiKey(principal.jti), familyKey(principal.familyId))) > 0;
    } catch (err) {
      throw new DenylistUnavailable(err instanceof Error ? err.message : String(err));
    }
  }

  private client(): Redis {
    if (!this.redis) throw new DenylistUnavailable('денилист не налаштований (REDIS_QUEUE_URL)');
    return this.redis;
  }
}
