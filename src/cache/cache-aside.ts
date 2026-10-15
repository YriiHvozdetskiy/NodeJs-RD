import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type Redis from 'ioredis';

export interface CacheAsideOptions {
  /** Базовий TTL значення, с. */
  ttlSeconds: number;
  /**
   * Розкид поверх базового TTL, с: TTL = ttlSeconds + random(0..ttlJitterSeconds).
   * Без нього ключі, прогріті одним циклом (деплой, нічний прогрів), протухли б
   * в одну секунду, і вся хвиля читань пішла б у базу разом.
   */
  ttlJitterSeconds: number;
  /** TTL для «такого немає» (null), с. Короткий: обʼєкт може зʼявитись. */
  missingTtlSeconds: number;
  /**
   * Скільки живе лок single-flight, мс. Має бути довшим за найповільніше
   * завантаження з бази: протух раніше — його візьме другий запит, і в базу
   * підуть двоє. Не катастрофа (див. README, розділ про Redis), але й не мета.
   */
  lockTtlMs: number;
  /** Як часто той, хто програв лок, перечитує кеш, мс. */
  pollMs: number;
}

/**
 * Compare-and-delete: зняти лок можна, лише якщо в ключі досі МІЙ токен.
 * Голий DEL зняв би чужий: мій лок протух, його взяв інший запит, а я,
 * закінчивши, видаляю ключ — тепер без лока лишився той, другий.
 * GET і DEL мусять бути атомарні, тому Lua: між ними ніхто не вклиниться.
 * З Redis 8.4 те саме вміє одна команда `DELEX key IFEQ token`; Lua працює
 * на будь-якій версії, зокрема на керованому Redis/Valkey у деплої (#28).
 */
export const UNLOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

/** `SET key token NX PX ttl`: true — лок мій, false — він уже чийсь. */
export async function acquireLock(redis: Redis, key: string, token: string, ttlMs: number): Promise<boolean> {
  return (await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
}

/** true — зняв свій; false — ключа немає або в ньому чужий токен (не чіпаю). */
export async function releaseLock(redis: Redis, key: string, token: string): Promise<boolean> {
  return (await redis.eval(UNLOCK_LUA, 1, key, token)) === 1;
}

export function jitteredTtl(baseSeconds: number, spreadSeconds: number): number {
  return baseSeconds + Math.floor(Math.random() * (spreadSeconds + 1));
}

/** Промах відрізняємо від закешованого null: «товару немає» — теж відповідь. */
const MISS = Symbol('miss');

type Op = 'read' | 'write' | 'lock' | 'unlock' | 'invalidate';

/**
 * Cache-aside з single-flight локом.
 *
 *   влучання → лише Redis;
 *   промах   → SET lock NX PX: виграв один запит — він іде в базу й пише
 *              кеш; решта чекає й перечитує кеш, а не йде в базу слідом.
 *
 * Лок тут — ОПТИМІЗАЦІЯ, а не захист інваріанта. Зламався (протух посеред
 * завантаження, Redis перезапустився, двоє взяли його після failover-у) —
 * у базу підуть двоє замість одного й однаково запишуть те саме. Тому тут
 * досить одного Redis і SET NX; інваріант, якому цього не досить (stock),
 * тримає Postgres атомарним UPDATE (src/checkout/checkout.ts).
 *
 * Кожна помилка Redis — запасний шлях у базу, а не помилка запиту: кеш, що
 * роняє запити, гірший за відсутність кешу.
 */
export class CacheAside {
  constructor(
    private readonly redis: Redis | undefined,
    private readonly options: CacheAsideOptions,
    private readonly onError: (op: Op, err: unknown) => void,
  ) {}

  async get<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const redis = this.redis;
    if (!redis) return load();

    const cached = await this.read<T>(redis, key);
    if (cached !== MISS) return cached;

    const lockKey = `lock:${key}`;
    const token = randomUUID();
    let mine: boolean;
    try {
      mine = await acquireLock(redis, lockKey, token, this.options.lockTtlMs);
    } catch (err) {
      this.onError('lock', err);
      return load();
    }

    if (mine) {
      try {
        // Повторна перевірка під локом. Між нашим промахом і SET NX попередній
        // власник міг устигнути записати значення й зняти свій лок — тоді ми
        // взяли вже непотрібний лок і пішли б у базу вдруге.
        const fresh = await this.read<T>(redis, key);
        if (fresh !== MISS) return fresh;
        const value = await load();
        await this.write(redis, key, value);
        return value;
      } finally {
        await releaseLock(redis, lockKey, token).catch((err: unknown) => this.onError('unlock', err));
      }
    }

    // Лок чужий: хтось уже пішов у базу. Чекаємо його результат у кеші.
    const deadline = Date.now() + this.options.lockTtlMs;
    while (Date.now() < deadline) {
      await sleep(this.options.pollMs);
      const value = await this.read<T>(redis, key);
      if (value !== MISS) return value;
      // Лока вже немає, а значення так і не зʼявилось — власник упав або не
      // зміг записати. Чекати більше нічого.
      const held = await redis.exists(lockKey).catch(() => 0);
      if (held === 0) break;
    }
    return load();
  }

  /** Явна інвалідація на записі — додатково до TTL, а не замість нього. */
  async invalidate(keys: string[]): Promise<void> {
    if (!this.redis || keys.length === 0) return;
    await this.redis.del(...keys).catch((err: unknown) => this.onError('invalidate', err));
  }

  private async read<T>(redis: Redis, key: string): Promise<T | null | typeof MISS> {
    let raw: string | null;
    try {
      raw = await redis.get(key);
    } catch (err) {
      this.onError('read', err);
      return MISS;
    }
    if (raw === null) return MISS;
    // Обгортка { v }, бо JSON-рядок "null" і відсутній ключ мусять відрізнятись.
    const entry: { v: T | null } = JSON.parse(raw);
    return entry.v;
  }

  private async write<T>(redis: Redis, key: string, value: T | null): Promise<void> {
    const ttl =
      value === null
        ? this.options.missingTtlSeconds
        : jitteredTtl(this.options.ttlSeconds, this.options.ttlJitterSeconds);
    await redis.set(key, JSON.stringify({ v: value }), 'EX', ttl).catch((err: unknown) => this.onError('write', err));
  }
}
