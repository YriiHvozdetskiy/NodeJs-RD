import {
  createParamDecorator,
  Injectable,
  SetMetadata,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { HttpProblem } from '../common/http-problem';
import type { UserRole } from '../entities/user.entity';
import { AccessDenylist, DenylistUnavailable } from './access-denylist';
import { AccessTokens, InvalidAccessToken, type Principal } from './access-tokens';

const PUBLIC = 'auth:public';
const ROLES = 'auth:roles';

/** Маршрут без токена: каталог, логін, рефреш, health. Усе інше закрите за замовчуванням. */
export const Public = (): CustomDecorator => SetMetadata(PUBLIC, true);

/** Яка роль потрібна. Перевіряє RolesGuard — ПІСЛЯ того, як AuthGuard встановив, хто це. */
export const Roles = (...roles: UserRole[]): CustomDecorator => SetMetadata(ROLES, roles);

/**
 * Особа запиту живе поруч із запитом, а не в module-level змінній: стан
 * модуля на сервері спільний для всіх запитів одразу. WeakMap не тримає
 * запит після відповіді.
 */
const principals = new WeakMap<Request, Principal>();

export function principalOf(req: Request): Principal | undefined {
  return principals.get(req);
}

/** `@CurrentPrincipal() principal: Principal` — особа, яку встановив AuthGuard. */
export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const principal = principalOf(ctx.switchToHttp().getRequest<Request>());
  // Сюди можна потрапити лише з @Public-маршруту — це помилка в коді, не в запиті.
  if (!principal) throw new Error('@CurrentPrincipal на маршруті без автентифікації');
  return principal;
});

/** `Authorization: Bearer <token>` → token. Схема без урахування регістру (RFC 7235 §2.1). */
export function bearerOf(header: string | undefined): string | undefined {
  const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(header ?? '');
  return match?.[1];
}

/**
 * АВТЕНТИФІКАЦІЯ: «хто це?». Глобальний гард, тож маршрут, на якому забули
 * поставити захист, закритий, а не відкритий: відкривати треба явно, @Public.
 *
 * Усі відмови тут — 401, і лише 401: токена немає, він зіпсований, протух,
 * підписаний не тим ключем, відкликаний. На 401 клієнтський SDK іде
 * рефрешити токен — і саме це тут правильно. Рішення «чи можна» тут не
 * ухвалюється взагалі: це 403, і його дає RolesGuard або сервіс.
 *
 * Гард стоїть до pipes і до обробника (L#8), тому про ресурс він нічого не
 * знає — і власність замовлення тут не перевіряється свідомо.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokens,
    private readonly denylist: AccessDenylist,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // WebSocket автентифікує сам gateway — на handshake (src/orders/orders.gateway.ts).
    if (ctx.getType() !== 'http') return true;
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const token = bearerOf(req.headers.authorization);
    if (!token) {
      // RFC 6750 §3: без error — запит просто не мав креденшелів.
      res.setHeader('WWW-Authenticate', 'Bearer realm="marketplace"');
      throw new HttpProblem(401, 'потрібен заголовок Authorization: Bearer <access-токен>', 'unauthenticated');
    }

    let principal: Principal;
    try {
      principal = await this.tokens.verify(token);
    } catch (err) {
      if (!(err instanceof InvalidAccessToken)) throw err;
      res.setHeader('WWW-Authenticate', 'Bearer realm="marketplace", error="invalid_token"');
      throw new HttpProblem(401, `access-токен не прийнято: ${err.message}`, 'unauthenticated');
    }

    let revoked: boolean;
    try {
      revoked = await this.denylist.isRevoked(principal);
    } catch (err) {
      if (!(err instanceof DenylistUnavailable)) throw err;
      // Не 401: токен може бути цілком чинним, і клієнт пішов би рефрешити
      // те, що рефрешу не потребує. Сервер не може перевірити — це 503.
      throw new HttpProblem(503, `не вдалось перевірити відкликання: ${err.message}`, 'service-unavailable');
    }
    if (revoked) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="marketplace", error="invalid_token"');
      throw new HttpProblem(401, 'access-токен відкликано (логаут або компрометація сесії)', 'unauthenticated');
    }

    principals.set(req, principal);
    return true;
  }
}

/**
 * АВТОРИЗАЦІЯ рівня ролі: «чи можна йому це?». Особа вже встановлена й
 * перевірена, тож відмова тут — 403, і клієнт НЕ рефрешить токен: новий
 * токен тієї самої особи отримає ту саму відмову.
 *
 * Роль читається з токена — це кеш на момент видачі, не джерело правди.
 * Свіжо розжалуваний адмін проходить цей гард до exp свого access-токена
 * (≤ 10 хв); наступний рефреш уже візьме роль із бази.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles) return true;

    const principal = principalOf(ctx.switchToHttp().getRequest<Request>());
    if (!principal) throw new HttpProblem(401, 'потрібна автентифікація', 'unauthenticated');
    if (!roles.includes(principal.role)) {
      throw new HttpProblem(403, `потрібна роль ${roles.join(' або ')}, у токені — ${principal.role}`, 'forbidden');
    }
    return true;
  }
}
