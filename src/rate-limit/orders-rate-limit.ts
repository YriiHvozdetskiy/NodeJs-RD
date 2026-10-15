import { Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { problemBody } from '../common/problem.filter';
import { RedisConnections } from '../redis/redis-connections';
import { SlidingWindowLimiter, type LimitVerdict } from './sliding-window';

/** 10 замовлень за будь-які 60 с з однієї адреси. */
export const ORDERS_LIMIT = 10;
export const ORDERS_WINDOW_MS = 60_000;

export function ordersRateLimitKey(ip: string): string {
  return `ratelimit:orders:${ip}`;
}

/** Як часто можна писати в лог про ту саму недоступність Redis. */
const WARN_EVERY_MS = 10_000;

/**
 * Ліміт на POST /v1/orders. Лічильник — у Redis-інстансі черги, спільному для
 * всіх подів: два поди з лічильником у памʼяті пропустили б 2 × ліміт, і жоден
 * локальний тест цього не побачив би, бо локально под один.
 *
 * Інстанс черги, а не кеш: allkeys-lru витісняє й вікна ліміту, і витіснене
 * вікно мовчки обнулює лічильник клієнта.
 *
 * Клієнт — `req.ip`, тобто адреса сокета. За балансувальником (#28) там буде
 * адреса балансувальника, і всі клієнти злились би в одного; тоді потрібен
 * `app.set('trust proxy', …)`, щоб Express брав адресу з X-Forwarded-For.
 */
@Injectable()
export class OrdersRateLimit {
  private readonly logger = new Logger('RateLimit');
  readonly limiter?: SlidingWindowLimiter;
  private lastWarnAt = 0;

  constructor(connections: RedisConnections) {
    this.limiter = connections.queue ? new SlidingWindowLimiter(connections.queue, ORDERS_LIMIT, ORDERS_WINDOW_MS) : undefined;
  }

  /**
   * Express-middleware, а не guard Nest: він стоїть ДО парсингу тіла й
   * валідатора спеки (src/app.setup.ts). Запит, який усе одно буде відхилено,
   * не повинен коштувати парсингу JSON і перевірки схеми.
   *
   * Redis недоступний — пропускаємо (fail-open). Ліміт захищає від зловживань,
   * а не тримає бізнес-інваріант: краще кілька зайвих замовлень, ніж магазин,
   * що не приймає жодного, поки лежить Redis.
   */
  middleware(): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
      // Express без strict routing віддає `/v1/orders/` тому самому обробнику.
      const path = req.path.length > 1 ? req.path.replace(/\/$/, '') : req.path;
      if (!this.limiter || req.method !== 'POST' || path !== '/v1/orders') return next();

      let verdict: LimitVerdict;
      try {
        verdict = await this.limiter.hit(ordersRateLimitKey(req.ip ?? 'unknown'));
      } catch (err) {
        this.warn(err);
        return next();
      }

      res.setHeader('RateLimit-Limit', String(this.limiter.limit));
      res.setHeader('RateLimit-Remaining', String(verdict.remaining));
      if (verdict.allowed) return next();

      // Секунди вгору: Retry-After — ціле число, і «0» клієнт прочитав би як
      // «можна вже», а вікно звільниться лише через частку секунди.
      const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
      res.setHeader('Retry-After', String(seconds));
      res
        .status(429)
        .type('application/problem+json')
        .json(problemBody(429, 'rate-limited', `не більше ${this.limiter.limit} замовлень за ${ORDERS_WINDOW_MS / 1000} с; повторіть через ${seconds} с`, req.originalUrl));
    };
  }

  private warn(err: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(`ліміт не перевірено, пропускаю: ${err instanceof Error ? err.message : String(err)}`);
  }
}
