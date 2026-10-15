import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * Ковзне вікно на ZSET: кожен пропущений запит — елемент зі score = час у мс.
 * «Скільки було за останні N мс» = ZCARD після того, як старше вікна видалено.
 *
 * Чому один Lua-скрипт, а не чотири команди з коду: між ZCARD і ZADD устиг би
 * влізти запит з іншого пода, обидва побачили б «4 із 5» і обидва пройшли б.
 * Ліміт протікав би саме під навантаженням, тобто тоді, коли він потрібен.
 * Redis виконує скрипт цілком, нічого між його рядками не вклиниться. Тут
 * атомарність — умова коректності, на відміну від лока в кеші.
 *
 * Час — `TIME` самого Redis, а не `Date.now()` пода: годинники подів
 * розходяться на десятки мс, а вікно в усіх має бути одне.
 *
 * Відхилений запит у вікно НЕ пишеться: клієнт, що молотить після 429,
 * не продовжує собі блокування, а чекає рівно Retry-After.
 *
 * KEYS[1] — ключ вікна; ARGV: вікно (мс), ліміт, унікальний member.
 * Повертає {дозволено 0|1, залишок, через скільки мс звільниться місце}.
 */
export const SLIDING_WINDOW_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local n = redis.call('ZCARD', KEYS[1])
if n < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, limit - n - 1, 0}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + window - now}`;

export interface LimitVerdict {
  allowed: boolean;
  remaining: number;
  /** Через скільки мс найстаріший запит вийде з вікна. 0, якщо пропущено. */
  retryAfterMs: number;
}

/**
 * Модель — ковзне вікно, бо сплеск на цьому маршруті не потрібен: оформлення
 * замовлень залпом — не поведінка покупця. Фіксоване вікно на межі пропустило
 * б 2× ліміту, token bucket віддав би повне відро одним залпом свідомо.
 *
 * Ціна моделі — памʼять: елемент на кожен пропущений запит у вікні, тобто до
 * `limit` елементів на клієнта. При ліміті в десятки це копійки.
 */
export class SlidingWindowLimiter {
  constructor(
    private readonly redis: Redis,
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  async hit(key: string): Promise<LimitVerdict> {
    // member унікальний: два запити в ту саму мілісекунду з однаковим member
    // злились би в один елемент ZSET, і другий пройшов би безкоштовно.
    const reply = await this.redis.eval(SLIDING_WINDOW_LUA, 1, key, this.windowMs, this.limit, randomUUID());
    if (!Array.isArray(reply) || reply.length !== 3 || !reply.every((n) => typeof n === 'number')) {
      throw new Error(`несподівана відповідь скрипта ліміту: ${JSON.stringify(reply)}`);
    }
    const [allowed, remaining, retryAfterMs] = reply;
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }
}
