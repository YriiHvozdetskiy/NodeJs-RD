import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import type { Env } from '../config/env.schema';

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
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;
  private readonly passwordFile: string;

  constructor(config: ConfigService<Env, true>) {
    const url = new URL(config.get('DB_URL', { infer: true }));
    this.passwordFile = path.resolve(config.get('DB_PASSWORD_FILE', { infer: true }));

    this.pool = new Pool({
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username),
      password: () => this.readPassword(),
      max: config.get('DB_POOL_MAX', { infer: true }),
    });

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

  /**
   * Читається на кожне НОВЕ з'єднання, не на кожен запит: запити, що взяли
   * з'єднання з пулу, у файл не ходять.
   */
  private async readPassword(): Promise<string> {
    return (await readFile(this.passwordFile, 'utf8')).trim();
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
