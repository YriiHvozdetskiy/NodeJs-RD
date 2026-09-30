import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';

export interface DbConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  /** Функція, а не рядок: драйвер викликає її на кожне НОВЕ з'єднання. */
  password: () => Promise<string>;
  max: number;
}

/**
 * Параметри підключення з провалідованого конфігу — одні на обидва пули
 * застосунку (`DatabaseService` і `OrmService`).
 *
 * Адреса приходить з `DB_URL` без пароля, пароль — з файла `DB_PASSWORD_FILE`,
 * і читається він не тут, а щоразу, коли пул відкриває з'єднання. Тому ротація
 * пароля (#11) діє на обидва пули без рестарту.
 */
export function dbConnection(config: ConfigService<Env, true>): DbConnection {
  const url = new URL(config.get('DB_URL', { infer: true }));
  const passwordFile = path.resolve(config.get('DB_PASSWORD_FILE', { infer: true }));

  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
    password: async () => (await readFile(passwordFile, 'utf8')).trim(),
    max: config.get('DB_POOL_MAX', { infer: true }),
  };
}
