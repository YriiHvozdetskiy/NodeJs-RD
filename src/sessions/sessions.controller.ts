import { Controller, Delete, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { HttpProblem } from '../common/http-problem';
import type { Session } from './session-store';
import { readCookie, SESSION_COOKIE, sessionOf, SessionsService, sessionUnreadable } from './sessions.service';

/** Схема `Session` зі спеки. */
interface SessionView {
  created_at: string;
  expires_at: string;
  idle_timeout_seconds: number;
}

/**
 * Гостьова сесія (#23). Логіну ще немає — його приносить #24 і пише userId у
 * ту саму сесію. Тут — лише механіка: де живе стан, як він подовжується і як
 * його відкликати.
 */
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  /**
   * Нова сесія завжди з НОВИМ id; стара, якщо була, видаляється. На #24 саме
   * тут стане логін, і це захист від session fixation: id, який хтось
   * підсунув браузеру до входу, після входу нічого не означає.
   */
  @Post()
  @HttpCode(201)
  async create(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SessionView> {
    const store = this.sessions.store;
    if (!store) throw new HttpProblem(503, 'сховище сесій не налаштоване (REDIS_QUEUE_URL)', 'service-unavailable');
    let session: Session;
    try {
      const previous = sessionOf(req);
      if (previous) await store.destroy(previous.sid);
      session = await store.create();
    } catch (err) {
      throw new HttpProblem(503, `сховище сесій недоступне: ${err instanceof Error ? err.message : String(err)}`, 'service-unavailable');
    }
    res.append('Set-Cookie', this.sessions.cookieFor(session));
    return this.view(session);
  }

  /** Читання саме по собі вже продовжило сесію — це зробив middleware. */
  @Get('current')
  current(@Req() req: Request): SessionView {
    const session = sessionOf(req);
    if (session) return this.view(session);
    if (sessionUnreadable(req)) throw new HttpProblem(503, 'сховище сесій недоступне', 'service-unavailable');
    throw new HttpProblem(401, 'сесії немає або вона протухла', 'unauthenticated');
  }

  /** Ідемпотентний вихід: немає сесії — однаково 204. */
  @Delete('current')
  @HttpCode(204)
  async destroy(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (sid && this.sessions.store) await this.sessions.store.destroy(sid);
    res.append('Set-Cookie', this.sessions.clearCookie());
  }

  private view(session: Session): SessionView {
    return {
      created_at: new Date(session.createdAt).toISOString(),
      expires_at: new Date(session.expiresAt).toISOString(),
      idle_timeout_seconds: this.sessions.store?.idleTimeoutSeconds ?? 0,
    };
  }
}
