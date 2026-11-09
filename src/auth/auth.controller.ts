import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { HttpProblem } from '../common/http-problem';
import { DB, type Queryable } from '../db/queryable';
import type { UserRole } from '../entities/user.entity';
import type { Principal } from './access-tokens';
import { AuthService, type TokenPair } from './auth.service';
import { CurrentPrincipal, Public } from './guards';

/** Схема `Me` зі спеки. */
interface MeView {
  id: number;
  email: string;
  role: UserRole;
  token_role: UserRole;
}

/**
 * Форму тіл (email, пароль, refresh_token) перевіряє валідатор спеки до входу
 * сюди — у методах лише рішення.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(DB) private readonly db: Queryable,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: { email: string; password: string }): Promise<TokenPair> {
    return this.auth.login(body.email, body.password);
  }

  /** Публічний: access-токен на цей момент зазвичай уже протух — саме тому клієнт сюди й прийшов. */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: { refresh_token: string }): Promise<TokenPair> {
    return this.auth.refresh(body.refresh_token);
  }

  /** Під access-токеном: він каже, ЯКУ сесію закрити, і сам іде в денилист. */
  @Post('logout')
  @HttpCode(204)
  logout(@CurrentPrincipal() principal: Principal): Promise<void> {
    return this.auth.logout(principal);
  }

  /**
   * Хто я. `role` — з бази, `token_role` — з токена: поки вони різні,
   * гарди вірять токену (README, розділ «Auth»).
   */
  @Get('me')
  async me(@CurrentPrincipal() principal: Principal): Promise<MeView> {
    const { rows } = await this.db.query<{ email: string; role: UserRole }>(`SELECT email, role FROM users WHERE id = $1`, [
      principal.userId,
    ]);
    const user = rows[0];
    if (!user) throw new HttpProblem(401, 'користувача з цього токена більше немає', 'unauthenticated');
    return { id: Number(principal.userId), email: user.email, role: user.role, token_role: principal.role };
  }
}
