import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Env } from '../config/env.schema';
import { RedisConnections } from '../redis/redis-connections';
import { SESSION_ABSOLUTE_TTL_SECONDS, SessionStore, type Session } from './session-store';

export const SESSION_COOKIE = 'sid';

/**
 * Сесія запиту — у WeakMap, а не полем на `req`: запит зник — запис зник
 * разом із ним, і типи Express не треба розширювати глобально.
 */
const sessions = new WeakMap<Request, Session>();

export function sessionOf(req: Request): Session | undefined {
  return sessions.get(req);
}

/**
 * Запити, чию сесію не вдалося прочитати (Redis недоступний). «Сесії немає» і
 * «не знаю, чи є» — різні відповіді: на першу 401 каже клієнту «увійди
 * знову», на другу правильна 503 «спробуй пізніше».
 */
const unreadable = new WeakSet<Request>();

export function sessionUnreadable(req: Request): boolean {
  return unreadable.has(req);
}

/** Значення cookie з заголовка `Cookie: a=1; sid=…`. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger('Sessions');
  /** Немає REDIS_QUEUE_URL — немає й сховища сесій. Памʼять процесу не підміняє його свідомо. */
  readonly store?: SessionStore;
  private readonly secure: boolean;

  constructor(connections: RedisConnections, config: ConfigService<Env, true>) {
    this.store = connections.queue ? new SessionStore(connections.queue) : undefined;
    this.secure = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /**
   * Middleware на КОЖЕН запит: є cookie — читає сесію з Redis і цим же
   * читанням продовжує її TTL (GETEX). Так активність на будь-якому маршруті
   * тримає сесію живою, а не лише запити до /v1/sessions.
   *
   * Redis недоступний — запит іде далі без сесії, позначений як
   * sessionUnreadable: маршрут, якому сесія потрібна, відповість 503, а
   * решта (каталог, замовлення) працює далі.
   */
  middleware(): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
      const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (this.store && sid) {
        try {
          const session = await this.store.touch(sid);
          if (session) sessions.set(req, session);
          // Протухла чи відкликана — браузеру нема чого слати її далі.
          else res.append('Set-Cookie', this.clearCookie());
        } catch (err) {
          unreadable.add(req);
          this.logger.warn(`сесію не прочитано: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      next();
    };
  }

  /**
   * HttpOnly — JS сторінки cookie не бачить, XSS його не вкраде.
   * SameSite=Lax — браузер не надішле його з чужого сайту на POST (CSRF).
   * Max-Age — абсолютна стеля сесії: cookie не переживе запис у Redis.
   * Secure — лише в production: локально API ходить по http.
   */
  cookieFor(session: Session): string {
    const attrs = [`${SESSION_COOKIE}=${session.sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_ABSOLUTE_TTL_SECONDS}`];
    if (this.secure) attrs.push('Secure');
    return attrs.join('; ');
  }

  clearCookie(): string {
    const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (this.secure) attrs.push('Secure');
    return attrs.join('; ');
  }
}
