import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type Redis from 'ioredis';
import { DB, type Queryable } from '../db/queryable';
import { RedisConnections } from '../redis/redis-connections';
import { ACCESS_TTL_SECONDS, type Principal } from './access-tokens';

/** Денилист недоступний: перевірити відкликання нічим — запит не пускаємо. */
export class DenylistUnavailable extends Error {}

export const jtiKey = (jti: string): string => `auth:deny:jti:${jti}`;
export const familyKey = (familyId: string): string => `auth:deny:fid:${familyId}`;

function unavailable(err: unknown): DenylistUnavailable {
  return new DenylistUnavailable(err instanceof Error ? err.message : String(err));
}

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
 *     злодія, коли спрацювала детекція повтору). TTL — до моменту, коли
 *     протухне останній access-токен сімʼї.
 *
 * Помилка Redis тут не ковтається, на відміну від кешу: «не змогли
 * перевірити, чи відкликано» не означає «не відкликано». Fail closed — 503.
 *
 * Джерело правди про відкликання — `refresh_tokens.revoked_at` у Postgres;
 * записи `fid` у Redis — похідна від нього, і `resync()` уміє зібрати їх
 * заново (після ревʼю #24, див. нижче).
 */
@Injectable()
export class AccessDenylist implements OnApplicationBootstrap {
  private readonly logger = new Logger('Denylist');
  private readonly redis: Redis;

  constructor(connections: RedisConnections, @Inject(DB) private readonly db: Queryable) {
    // Після ревʼю #24: раніше без REDIS_QUEUE_URL застосунок стартував, а кожен
    // запит під токеном отримував 503. Для сесій і ліміту «вимкнено» — чесний
    // режим, для автентифікації — ні: логаут без денилиста не відкликає access.
    // Тож процес падає тут, на збиранні DI, з назвою змінної — до listen.
    if (!connections.queue) {
      throw new Error(
        'REDIS_QUEUE_URL не задано: денилист access-токенів живе в Redis черги, ' +
          'і без нього логаут не відкликав би access-токени — застосунок не стартує',
      );
    }
    this.redis = connections.queue;
    // Кожне (пере)підключення — привід звіритись із Postgres: поки Redis лежав,
    // логаут і детекція повтору встигли закомітити revoked_at, а запис у
    // денилист до Redis не дійшов. Першого `ready` тут не буде — клієнт уже
    // готовий; перший прохід робить onApplicationBootstrap.
    this.redis.on('ready', () => void this.resync('реконект'));
  }

  onApplicationBootstrap(): void {
    // Не await: лежача база чи Redis не причина не піднімати API — прохід
    // повториться на наступному реконекті.
    void this.resync('старт');
  }

  /** Логаут: цей токен і всі токени його сімʼї. */
  async revoke(principal: Principal): Promise<void> {
    const remaining = principal.expiresAt - Math.floor(Date.now() / 1000);
    try {
      const tx = this.redis.multi().set(familyKey(principal.familyId), '1', 'EX', ACCESS_TTL_SECONDS);
      // Протухлий токен сюди не дійде (його відкинув би гард), але межа
      // секунди між гардом і цим рядком реальна: EX 0 Redis відхилив би.
      if (remaining > 0) tx.set(jtiKey(principal.jti), '1', 'EX', remaining);
      await tx.exec();
    } catch (err) {
      throw unavailable(err);
    }
  }

  /**
   * Уся сімʼя — детекція повтору (jti токена злодія невідомий) і повторне
   * предʼявлення вже відкликаного токена. `ttlSeconds` — скільки ще може жити
   * останній access-токен сімʼї; за замовчуванням — увесь TTL access.
   * Ідемпотентно: той самий ключ, той самий зміст.
   */
  async revokeFamily(familyId: string, ttlSeconds: number = ACCESS_TTL_SECONDS): Promise<void> {
    try {
      await this.redis.set(familyKey(familyId), '1', 'EX', ttlSeconds);
    } catch (err) {
      throw unavailable(err);
    }
  }

  /** Одна команда на обидва ключі: EXISTS повертає, скільки з них є. */
  async isRevoked(principal: Principal): Promise<boolean> {
    try {
      return (await this.redis.exists(jtiKey(principal.jti), familyKey(principal.familyId))) > 0;
    } catch (err) {
      throw unavailable(err);
    }
  }

  /**
   * Звірка Redis із Postgres. Сімʼї, відкликані за останні ACCESS_TTL_SECONDS,
   * ще можуть мати живі access-токени: після revoked_at сімʼя нових не
   * отримує, тож останній із них протухне не пізніше за revoked_at + TTL.
   * Рівно на цей залишок і ставиться запис. Давніші сімʼї пропускаємо — їхні
   * токени вже мертві самі.
   *
   * Закриває дірку dual write з обох боків: логаут, що закомітив revoked_at і
   * не дописав денилист (503, а клієнт так і не повторив), і детекцію
   * повтору, яка відкликала сімʼю, поки Redis лежав.
   *
   * Без індексу по revoked_at: прохід буває лише на старті й після реконекту,
   * а не на кожен запит.
   */
  async resync(reason: string): Promise<number> {
    try {
      const { rows } = await this.db.query<{ family_id: string; ttl: number }>(
        `SELECT family_id,
                ceil(extract(epoch FROM max(revoked_at) + make_interval(secs => $1) - now()))::int AS ttl
           FROM refresh_tokens
          WHERE revoked_at > now() - make_interval(secs => $1)
          GROUP BY family_id`,
        [ACCESS_TTL_SECONDS],
      );
      const live = rows.filter((row) => row.ttl > 0);
      if (live.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const row of live) pipeline.set(familyKey(row.family_id), '1', 'EX', row.ttl);
        // pipeline не кидає на помилці окремої команди — вона лежить у парі [err, result].
        const failed = (await pipeline.exec())?.find(([err]) => err !== null)?.[0];
        if (failed) return this.resyncFailed(reason, failed);
      }
      this.logger.log(`resync (${reason}): сімей у денилисті з Postgres — ${live.length}`);
      return live.length;
    } catch (err) {
      return this.resyncFailed(reason, err);
    }
  }

  private resyncFailed(reason: string, err: unknown): number {
    this.logger.warn(`resync (${reason}) не вдався: ${err instanceof Error ? err.message : String(err)} — повторю на наступному реконекті`);
    return 0;
  }
}
