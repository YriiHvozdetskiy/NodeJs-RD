import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

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
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  /** Liveness: процес живий. У БД не ходить — інакше падіння БД «вбивало» б под. */
  @Get()
  live(): { status: string; uptime_sec: number } {
    return { status: 'ok', uptime_sec: uptimeSec() };
  }

  /**
   * Readiness: сервіс справді дістає БД. Саме цей запит бере з'єднання з пулу,
   * а нове з'єднання перечитує файл-секрет — тобто після ротації тут видно
   * новий пароль без рестарту.
   */
  @Get('db')
  async ready(): Promise<{ status: string; db_user: string; db_now: string; uptime_sec: number }> {
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
