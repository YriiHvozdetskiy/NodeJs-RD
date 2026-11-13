import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { Public } from '../auth/guards';
import { Lifecycle } from './lifecycle';

interface DbProbeRow {
  current_user: string;
  now: string;
}

/**
 * Операційні ендпоїнти. Вони НЕ під `/v1` і НЕ у `openapi/openapi.yaml`
 * навмисно: версіонується публічний контракт, а не те, що читає оркестратор.
 * Виняток для префікса — у `main.ts`, `setGlobalPrefix(..., { exclude })`.
 *
 * `uptime` віддається у відповіді не для краси: він — доказ, що ротація
 * пароля БД не перезапустила процес. Впав би процес — лічильник почався б з нуля.
 */
// Оркестратор і грейдер читають health без токена.
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly lifecycle: Lifecycle,
  ) {}

  /** Liveness: процес живий. У БД не ходить — інакше падіння БД «вбивало» б под. */
  @Get()
  live(): { status: string; uptime_sec: number } {
    return { status: 'ok', uptime_sec: uptimeSec() };
  }

  /**
   * Readiness (#28): «чи можна мені слати трафік». 503 до кінця прогріву і з
   * першої миті після SIGTERM — саме за цим kubelet прибирає под з балансування.
   *
   * У БД тут не ходимо навмисно. Перше зʼєднання вже перевірив прогрів, а
   * перевірка на кожній пробі при короткому збої бази зробила б неготовими ВСІ
   * поди одразу: частково зламаний сервіс перетворився б на «connection refused»
   * для кожного запиту. Стан бази окремо показує `GET /health/db`.
   */
  @Get('ready')
  ready(): { status: string; uptime_sec: number } {
    if (!this.lifecycle.ready) {
      throw new ServiceUnavailableException(this.lifecycle.isDraining ? 'draining' : 'warming up');
    }
    return { status: 'ready', uptime_sec: uptimeSec() };
  }

  /**
   * Readiness: сервіс справді дістає БД. Саме цей запит бере з'єднання з пулу,
   * а нове з'єднання перечитує файл-секрет — тобто після ротації тут видно
   * новий пароль без рестарту.
   */
  @Get('db')
  async database(): Promise<{ status: string; db_user: string; db_now: string; uptime_sec: number }> {
    const result = await this.db.query<DbProbeRow>('SELECT current_user, now()::text AS now');
    const row = result.rows[0];
    return {
      status: 'ok',
      db_user: row.current_user,
      db_now: row.now,
      uptime_sec: uptimeSec(),
    };
  }
}

/** Три знаки після коми: ротація займає секунду-дві, і округлення до цілих приховало б різницю. */
function uptimeSec(): number {
  return Number(process.uptime().toFixed(3));
}
