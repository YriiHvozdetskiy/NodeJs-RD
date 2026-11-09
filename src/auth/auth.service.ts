import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import { HttpProblem } from '../common/http-problem';
import type { Env } from '../config/env.schema';
import { OrmService } from '../db/orm.service';
import { DB, type Queryable } from '../db/queryable';
import { sql } from '../db/sql';
import type { UserRole } from '../entities/user.entity';
import { AccessDenylist, DenylistUnavailable } from './access-denylist';
import { ACCESS_TTL_SECONDS, AccessTokens, type Principal } from './access-tokens';
import { dummyHash, verifyPassword } from './passwords';

/** Скільки живе сесія від логіна. Ротація цю межу не відсуває. */
export const REFRESH_TTL_DAYS = 30;

/** Те, що віддають login і refresh, — схема `TokenPair` зі спеки. */
export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

/**
 * Чим закінчився рефреш. Усі гілки, крім `rotated`, — 401 для клієнта (або
 * 503, якщо не вдалось дописати денилист), але для сервера вони різні:
 * `reuse` — єдина, що змінює стан бази (відкликає сімʼю), і саме тому
 * транзакція повертає результат, а не кидає виняток — виняток відкотив би це
 * відкликання разом із транзакцією.
 */
type RefreshOutcome =
  | { kind: 'rotated'; pair: TokenPair }
  | { kind: 'unknown' }
  | { kind: 'expired' }
  | { kind: 'revoked'; familyId: string; denyTtl: number }
  | { kind: 'reuse'; familyId: string; userId: string; tokenId: string; revoked: number };

interface RefreshRow {
  id: string;
  user_id: string;
  family_id: string;
  used: boolean;
  revoked: boolean;
  expired: boolean;
  expires_at: Date;
  /** Скільки секунд ще може жити останній access-токен відкликаної сімʼї; null — не відкликана. */
  deny_ttl: number | null;
  role: UserRole;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  private readonly pepper: string;

  constructor(
    @Inject(DB) private readonly db: Queryable,
    private readonly orm: OrmService,
    private readonly access: AccessTokens,
    private readonly denylist: AccessDenylist,
    config: ConfigService<Env, true>,
  ) {
    this.pepper = config.get('REFRESH_TOKEN_PEPPER', { infer: true });
  }

  /**
   * Пароль → нова сімʼя refresh-токенів і перша пара. Немає email і не той
   * пароль — одна й та сама відповідь за той самий час: інакше логін став би
   * оракулом «чи зареєстрований цей email».
   */
  async login(email: string, password: string): Promise<TokenPair> {
    const { rows } = await this.db.query<{ id: string; role: UserRole; password_hash: string }>(
      `SELECT id, role, password_hash FROM users WHERE email = $1`,
      [email],
    );
    const user = rows[0];
    const stored = user?.password_hash.startsWith('scrypt$') ? user.password_hash : await dummyHash();
    const ok = await verifyPassword(password, stored);
    if (!user || !ok) throw new HttpProblem(401, 'невірний email або пароль', 'unauthenticated');

    const familyId = randomUUID();
    const refreshToken = newRefreshToken();
    await this.db.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [user.id, familyId, this.hash(refreshToken), REFRESH_TTL_DAYS],
    );
    const issued = await this.access.issue(user, familyId);
    this.logger.log(`login: user=${user.id} family=${familyId} jti=${issued.jti}`);
    return pair(issued.token, refreshToken, issued.expiresIn);
  }

  /**
   * Ротація з детекцією повтору — RFC 9700 §4.14.2.
   *
   * Кожен рефреш обмінює токен на нову пару і позначає старий `used_at`.
   * Предʼявили вже використаний токен — значить, ним користуються двоє:
   * клієнт і той, хто його вкрав. Хто з них чесний, сервер не знає, тому
   * відкликає сімʼю цілком — і злодій, і чесний клієнт вилітають на логін.
   * Ротація без цього кроку не дає нічого: злодій рефрешиться першим, а
   * клієнт отримує 401 і мовчки перелогінюється, лишивши злодію живу сесію.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const dataSource = await this.orm.get();
    const outcome = await dataSource.transaction('READ COMMITTED', (manager) => this.rotate(manager, refreshToken));

    switch (outcome.kind) {
      case 'rotated':
        return outcome.pair;
      case 'reuse':
        // Рядок, заради якого все це: компрометацію видно в лозі. Токенів у
        // лозі немає — лише ідентифікатори.
        this.logger.warn(
          `refresh reuse detected: family=${outcome.familyId} user=${outcome.userId} token=${outcome.tokenId} — ` +
            `сімʼю відкликано, живих refresh-токенів у ній було: ${outcome.revoked}`,
        );
        // Access-токен злодія ще живий до exp — закриваємо сімʼю й у денилисті.
        await this.denyFamily(outcome.familyId, ACCESS_TTL_SECONDS);
        throw new HttpProblem(401, 'refresh-токен уже використано — сесію відкликано, потрібен новий логін', 'unauthenticated');
      case 'revoked':
        // Після ревʼю #24. Сюди приходить і повтор після 503 з гілки вище:
        // сімʼя в базі вже мертва, а запис у денилист міг не дійти. Тому й тут
        // сімʼя пишеться в денилист — ідемпотентно, на залишок життя її
        // останнього access-токена. Без цього повтор клієнта отримав би 401,
        // а токен злодія жив би до exp. Давно відкликані сімʼї (denyTtl ≤ 0)
        // не чіпаємо: їхніх живих токенів уже немає.
        if (outcome.denyTtl > 0) await this.denyFamily(outcome.familyId, outcome.denyTtl);
        throw new HttpProblem(401, 'сесію відкликано — потрібен новий логін', 'unauthenticated');
      case 'expired':
        throw new HttpProblem(401, 'refresh-токен протух — потрібен новий логін', 'unauthenticated');
      case 'unknown':
        throw new HttpProblem(401, 'невідомий refresh-токен', 'unauthenticated');
    }
  }

  /**
   * Логаут — дві дії в двох сховищах, і атомарно їх не зробити (той самий dual
   * write, що в #22). Тому важить порядок і те, що повтор безпечний:
   *
   *   1. COMMIT у Postgres: revoked_at на всю сімʼю. Після цього нову пару з
   *      цього логіна не отримати.
   *   2. SET у Redis: jti цього токена і сімʼя — у денилист. Після цього
   *      наявний access-токен не пройде гард.
   *
   * Упав крок 2 — сесія вже не продовжиться, а access доживе до exp
   * (≤ 10 хв). Клієнт отримує 503 і повторює логаут: крок 1 вдруге нічого не
   * змінює, крок 2 нарешті проходить. Зворотний порядок був би гірший: Redis
   * встиг, Postgres ні — і клієнт із живим refresh просто взяв би новий
   * access, тобто логаут не відбувся б узагалі.
   *
   * Клієнт, що так і не повторив логаут, теж не лишає дірки: revoked_at уже в
   * базі, і `AccessDenylist.resync()` допише сімʼю в денилист, щойно Redis
   * підніметься (після ревʼю #24).
   */
  async logout(principal: Principal): Promise<void> {
    const { rowCount } = await this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
      [principal.familyId],
    );
    try {
      await this.denylist.revoke(principal);
    } catch (err) {
      if (!(err instanceof DenylistUnavailable)) throw err;
      throw new HttpProblem(503, `логаут не завершено: денилист недоступний (${err.message}) — повтори запит`, 'service-unavailable');
    }
    this.logger.log(`logout: user=${principal.userId} family=${principal.familyId} jti=${principal.jti} refresh-revoked=${rowCount ?? 0}`);
  }

  /**
   * Уся ротація — одна транзакція: «старий використано» і «новий виписано»
   * комітяться разом або ніяк.
   *
   * FOR UPDATE на рядку токена серіалізує два рефреші того самого токена:
   * другий чекає на лок, після COMMIT першого READ COMMITTED перечитує рядок
   * і бачить used_at — тобто повтор. Без локу обидва прочитали б used_at IS
   * NULL і обидва отримали б нову пару: дві живі гілки однієї сімʼї.
   *
   * Роль береться з `users`, а не з попереднього токена: роль у токені — кеш,
   * і рефреш — те місце, де цей кеш оновлюється.
   */
  private async rotate(manager: EntityManager, refreshToken: string): Promise<RefreshOutcome> {
    const [row] = await sql<RefreshRow>(
      manager,
      `SELECT rt.id, rt.user_id, rt.family_id, rt.expires_at,
              rt.used_at IS NOT NULL AS used,
              rt.revoked_at IS NOT NULL AS revoked,
              rt.expires_at <= now() AS expired,
              ceil(extract(epoch FROM rt.revoked_at + make_interval(secs => $2) - now()))::int AS deny_ttl,
              u.role
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1
          FOR UPDATE OF rt`,
      [this.hash(refreshToken), ACCESS_TTL_SECONDS],
    );
    if (!row) return { kind: 'unknown' };
    // Порядок перевірок важливий: відкликаний токен міг бути й використаним,
    // і тоді це не новий сигнал компрометації, а відгомін уже обробленого.
    if (row.revoked) return { kind: 'revoked', familyId: row.family_id, denyTtl: row.deny_ttl ?? 0 };
    if (row.used) {
      const revoked = await sql<{ id: string }>(
        manager,
        `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL RETURNING id`,
        [row.family_id],
      );
      return { kind: 'reuse', familyId: row.family_id, userId: row.user_id, tokenId: row.id, revoked: revoked.length };
    }
    if (row.expired) return { kind: 'expired' };

    const next = newRefreshToken();
    await sql(manager, `UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [row.id]);
    await sql(
      manager,
      `INSERT INTO refresh_tokens (user_id, family_id, parent_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [row.user_id, row.family_id, row.id, this.hash(next), row.expires_at],
    );
    // Підпис — до COMMIT: після нього лишається тільки відправити відповідь.
    // Упав би підпис після COMMIT — старий токен уже used, новий ніхто не
    // отримав, і наступна спроба клієнта виглядала б як повтор.
    const issued = await this.access.issue({ id: row.user_id, role: row.role }, row.family_id);
    return { kind: 'rotated', pair: pair(issued.token, next, issued.expiresIn) };
  }

  /**
   * Сімʼя в денилист — або 503. Після ревʼю #24: раніше помилку Redis тут
   * ковтав `.catch`, і access злодія жив до exp без жодного повтору. Тепер
   * клієнт отримує 503 і повторює рефреш; той самий токен приходить у гілку
   * `revoked`, яка дописує сімʼю вдруге. Якщо не повторить ніхто — запис
   * відновить `AccessDenylist.resync()`, щойно Redis підніметься.
   */
  private async denyFamily(familyId: string, ttlSeconds: number): Promise<void> {
    try {
      await this.denylist.revokeFamily(familyId, ttlSeconds);
    } catch (err) {
      if (!(err instanceof DenylistUnavailable)) throw err;
      this.logger.error(`family=${familyId}: денилист недоступний (${err.message}) — 503, чекаю на повтор або resync`);
      throw new HttpProblem(
        503,
        `сесію відкликано, але access-токени цієї сесії ще не закриті: денилист недоступний (${err.message}) — повтори запит`,
        'service-unavailable',
      );
    }
  }

  /** HMAC, а не голий SHA-256: без перцю зі сховища хеш у дампі не перевірити. */
  private hash(refreshToken: string): string {
    return createHmac('sha256', this.pepper).update(refreshToken).digest('hex');
  }
}

/** 256 біт ентропії, base64url. Непрозорий рядок, не JWT: усе про нього знає лише база. */
function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

function pair(accessToken: string, refreshToken: string, expiresIn: number): TokenPair {
  return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: expiresIn };
}
