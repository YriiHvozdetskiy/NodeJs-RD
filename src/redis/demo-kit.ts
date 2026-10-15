import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import Redis, { type RedisOptions } from 'ioredis';
import { DataSource } from 'typeorm';
import { APP_OPTIONS, configureApp } from '../app.setup';
import { dataSourceOptions } from '../data-source';
import { cliDbConfig, requiredEnv } from '../db/cli-env';
import { migrate } from '../messaging/demo-kit';
import { untilReady } from './redis-connections';

/**
 * Спільне для демо #23 (demo:cache, demo:session, demo:ratelimit, demo:queue).
 * Як і демо #19/#22, кожне з них:
 *   1. саме доводить базу до схеми (міграції) — грейдеру не потрібен окремий крок;
 *   2. працює у власному просторі імен Redis і прибирає за собою;
 *   3. друкує ключ=значення і саме перевіряє інваріанти (код виходу).
 */

/** Адреси приходять від scripts/with-secrets.sh — або від грейдера під SKIP_VAULT=1. */
export type RedisEnv = 'REDIS_CACHE_URL' | 'REDIS_QUEUE_URL';

export async function openRedis(env: RedisEnv, name: string, options: RedisOptions = {}): Promise<Redis> {
  const client = new Redis(requiredEnv(env), { connectionName: name, ...options });
  try {
    await untilReady(client);
  } catch (err) {
    client.disconnect();
    throw new Error(`${env}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return client;
}

/** Значення параметра з CONFIG GET: ioredis віддає плаский масив [імʼя, значення]. */
export async function configGet(redis: Redis, name: string): Promise<string> {
  const reply = await redis.config('GET', name);
  if (Array.isArray(reply) && typeof reply[1] === 'string') return reply[1];
  throw new Error(`CONFIG GET ${name}: несподівана відповідь ${JSON.stringify(reply)}`);
}

/** Схема тими самими міграціями, що `npm run migrate`. */
export async function migrateSchema(): Promise<number> {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  try {
    return await migrate(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

/** Ключі з цим префіксом — SCAN, а не KEYS: KEYS блокує Redis на весь прохід. */
export async function keysWithPrefix(redis: Redis, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return keys;
}

export interface Api {
  url: string;
  close(): Promise<void>;
}

/**
 * Справжній AppModule на ефемерному порту, тим самим configureApp, що й
 * main.ts: rate-limit, сесії, валідатор спеки, problem+json. Той самий прийом,
 * що в demo:outbox (#22): адреса бази в DB_URL без пароля, пароль файлом, із
 * DB_*, які дала обгортка. Брокер вимкнено — вбудований relay тут ні до чого.
 *
 * Імпорт AppModule динамічний і ПІСЛЯ env: ConfigModule.forRoot() валідує
 * оточення в момент імпорту файла.
 */
export async function startApi(): Promise<Api> {
  const db = cliDbConfig();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-api-'));
  const passwordFile = path.join(dir, 'db_password');
  await writeFile(passwordFile, db.password, { mode: 0o600 });

  Object.assign(process.env, {
    DB_URL: `postgres://${encodeURIComponent(db.user)}@${db.host}:${db.port}/${encodeURIComponent(db.database)}`,
    DB_PASSWORD_FILE: passwordFile,
    BROKER_URL: '',
    DRIFT: '0',
    SLOW_MS: '0',
    CORS_ORIGINS: '',
    // Повні URL з паролем від обгортки — файл REDIS_PASSWORD_FILE не читається.
    REDIS_CACHE_URL: requiredEnv('REDIS_CACHE_URL'),
    REDIS_QUEUE_URL: requiredEnv('REDIS_QUEUE_URL'),
  });
  const { AppModule } = await import('../app.module');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { ...APP_OPTIONS, logger: ['error', 'warn'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();

  return {
    url,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Повідомлення пода батьківському процесу демо (IPC). */
export interface PodReport {
  t: 'ready';
  url: string;
  pid: number;
}

function isPodReport(m: unknown): m is PodReport {
  return typeof m === 'object' && m !== null && 't' in m && m.t === 'ready' && 'url' in m && typeof m.url === 'string';
}

/**
 * Под — застосунок в ОКРЕМОМУ процесі ОС (dist/demo-ratelimit-pod.js). Два
 * застосунки в одному процесі ділили б памʼять модулів, і лічильник у
 * module-level Map пройшов би перевірку «ліміт спільний» нечесно.
 */
export class PodProcess {
  private constructor(
    private readonly proc: ChildProcess,
    readonly url: string,
    readonly pid: number,
  ) {}

  static start(label: string, timeoutMs = 30_000): Promise<PodProcess> {
    const proc = fork(path.join(__dirname, '..', 'demo-ratelimit-pod.js'), {
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`${label} не стартував за ${timeoutMs} мс`));
      }, timeoutMs);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`${label} вийшов з кодом ${code} до готовності`));
      });
      proc.on('message', (m) => {
        if (!isPodReport(m)) return;
        clearTimeout(timer);
        proc.removeAllListeners('exit');
        resolve(new PodProcess(proc, m.url, m.pid));
      });
    });
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.proc.once('exit', () => resolve()));
    this.proc.kill('SIGTERM');
    const forced = setTimeout(() => this.proc.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(forced);
  }
}
