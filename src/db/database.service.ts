import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import type { Env } from '../config/env.schema';
import { dbConnection } from './connection';
import type { Queryable } from './queryable';

/**
 * Пул з'єднань до Postgres, який ПЕРЕЖИВАЄ ротацію пароля без рестарту процесу.
 *
 * Два прийоми, які це вмикають:
 *
 *   1. Пароль — не змінна оточення, а ФАЙЛ. Оточення процесу читається один раз
 *      при старті процесу і після цього замерзає: щоб застосунок побачив нове
 *      значення, його треба перезапустити. Файл можна перечитати будь-коли.
 *      Так само секрети монтують Docker Swarm (`/run/secrets/*`) і Kubernetes
 *      (Secret як volume).
 *
 *   2. У `pg.Pool` поле `password` приймає ФУНКЦІЮ, і драйвер викликає її на
 *      КОЖНЕ нове з'єднання. Postgres перевіряє пароль лише під час handshake,
 *      тож уже відкриті з'єднання живуть зі старим — а нові беруть свіжий
 *      із файла. Саме тому ротація не потребує рестарту.
 *
 * Адреса БД приходить з `DB_URL` без пароля: `postgres://app_user@host:5432/db`.
 * Пароль і адреса свідомо роз'їхані по різних каналах — рядок підключення можна
 * покласти у конфіг-мапу чи в лог, і секрету в ньому немає.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy, Queryable {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService<Env, true>) {
    // Парсинг DB_URL і читання файла-пароля — у src/db/connection.ts: ті самі
    // параметри бере й `OrmService`, і ротація має діяти на обидва пули.
    // Пароль читається на кожне НОВЕ з'єднання, не на кожен запит: запити, що
    // взяли з'єднання з пулу, у файл не ходять.
    const { host, port, database, user, password, max } = dbConnection(config);
    this.pool = new Pool({ host, port, database, user, password, max });

    // ОБОВ'ЯЗКОВО. Коли сервер закриває idle-з'єднання — ротація,
    // `pg_terminate_backend`, failover реплік — пул емітить 'error' на об'єкті,
    // якого ніхто не чекає. Без цього обробника Node падає з
    // "Unhandled 'error' event", і виглядає це як баг ротації.
    // Насправді ротація тут ні до чого: пул сам відкриє нове з'єднання.
    this.pool.on('error', (err: NodeJS.ErrnoException) => {
      this.logger.warn(
        `Сервер закрив idle-з'єднання (${err.code ?? err.message}) — пул відкриє нове, процес живе`,
      );
    });
  }

  query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }

  /**
   * `app.enableShutdownHooks()` у main.ts доводить сюди SIGTERM: пул дочікує
   * активні запити й закриває сокети сам, замість того щоб їх обірвало SIGKILL.
   */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
