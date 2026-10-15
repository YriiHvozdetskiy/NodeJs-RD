import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Скільки сесія живе без активності. Кожен запит із нею відсуває межу на
 * повні 30 хв (rolling TTL): активного користувача не викине посеред роботи,
 * а покинута вкладка звільнить памʼять сама.
 */
export const SESSION_IDLE_TTL_SECONDS = 30 * 60;

/**
 * Стеля від моменту створення, хоч би якою активною була сесія. Без неї
 * вкрадений cookie, яким постійно користуються, жив би вічно: rolling TTL
 * подовжує його так само, як справжньому власнику.
 */
export const SESSION_ABSOLUTE_TTL_SECONDS = 12 * 60 * 60;

/** 32 випадкові байти в base64url — рівно 43 символи. */
const SID_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** Те, що лежить у Redis. userId зʼявиться з логіном на #24. */
interface StoredSession {
  createdAt: number;
  userId: string | null;
}

export interface Session extends StoredSession {
  /** Значення cookie. У Redis не зберігається — лише його хеш у ключі. */
  sid: string;
  /** Коли сесія протухне, якщо далі запитів не буде, мс epoch. */
  expiresAt: number;
}

/**
 * Ключ — SHA-256 від sid, а не сам sid. Хто прочитав Redis (дамп, MONITOR,
 * чужий доступ до інстансу), бачить хеші, а з хешу cookie не відновиш.
 * Звичайний хеш без солі тут достатній: sid — 256 біт випадковості, а не
 * пароль, перебирати нічого.
 */
export function sessionKey(sid: string): string {
  return `session:${createHash('sha256').update(sid).digest('base64url')}`;
}

/**
 * Сесії в Redis-інстансі черги (noeviction + AOF), не в кеші: allkeys-lru
 * колись витіснив би сесію, і користувача розлогінило б без жодної причини, яку
 * можна відтворити. Чому не третій інстанс — README, розділ про Redis.
 */
export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly idleTtlSeconds = SESSION_IDLE_TTL_SECONDS,
    private readonly absoluteTtlSeconds = SESSION_ABSOLUTE_TTL_SECONDS,
  ) {}

  get idleTimeoutSeconds(): number {
    return this.idleTtlSeconds;
  }

  async create(): Promise<Session> {
    const sid = randomBytes(32).toString('base64url');
    const stored: StoredSession = { createdAt: Date.now(), userId: null };
    // NX — не перезаписати чужу сесію. Збіг 256-бітних id практично
    // неможливий, але вартість перевірки нульова.
    const ok = await this.redis.set(sessionKey(sid), JSON.stringify(stored), 'EX', this.idleTtlSeconds, 'NX');
    if (ok !== 'OK') throw new Error('sid уже зайнятий');
    return this.view(sid, stored);
  }

  /**
   * Прочитати й продовжити ОДНІЄЮ командою: GETEX повертає значення і ставить
   * новий TTL атомарно. GET + EXPIRE двома командами — два походи в Redis на
   * кожен запит і щілина між ними, в яку ключ устигає протухнути.
   */
  async touch(sid: string): Promise<Session | null> {
    // Сміття в cookie не варте походу в Redis.
    if (!SID_FORMAT.test(sid)) return null;
    const key = sessionKey(sid);
    const raw = await this.redis.getex(key, 'EX', this.idleTtlSeconds);
    if (raw === null) return null;
    const stored: StoredSession = JSON.parse(raw);
    if (Date.now() - stored.createdAt > this.absoluteTtlSeconds * 1000) {
      await this.redis.del(key);
      return null;
    }
    return this.view(sid, stored);
  }

  /** Відкликати — просто видалити ключ. Саме цим сесія й зручніша за JWT (#24). */
  async destroy(sid: string): Promise<void> {
    if (SID_FORMAT.test(sid)) await this.redis.del(sessionKey(sid));
  }

  private view(sid: string, stored: StoredSession): Session {
    const idleEnd = Date.now() + this.idleTtlSeconds * 1000;
    const absoluteEnd = stored.createdAt + this.absoluteTtlSeconds * 1000;
    return { sid, ...stored, expiresAt: Math.min(idleEnd, absoluteEnd) };
  }
}
