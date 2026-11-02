import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import type { Env } from '../config/env.schema';

/**
 * Опції клієнта, через якого ходить HTTP-запит. Дефолти ioredis розраховані
 * на інше: команда без зʼєднання чекає в offline-черзі, доки Redis не
 * повернеться, — тобто запит користувача висить. Для кешу, сесій і ліміту
 * правильна поведінка протилежна: Redis лежить або тупить → команда падає за
 * пів секунди, і код іде запасним шляхом (база, «без сесії», без ліміту).
 *
 *   enableOfflineQueue: false — немає зʼєднання → помилка одразу, а не очікування;
 *   commandTimeout: 500      — живий, але завислий Redis теж не тримає запит;
 *   maxRetriesPerRequest: 1  — одна повторна спроба після обриву, не двадцять.
 *
 * Воркер BullMQ — навпаки (src/worker.ts): він не обслуговує людину, тож
 * має чекати на Redis скільки завгодно (`maxRetriesPerRequest: null`).
 */
export const REQUEST_PATH_OPTIONS: RedisOptions = {
  enableOfflineQueue: false,
  commandTimeout: 500,
  connectTimeout: 2_000,
  maxRetriesPerRequest: 1,
};

/**
 * Адреса Redis у тому самому форматі, що адреси бази й брокера (#11): у конфігу
 * — `redis://default@host:port` без пароля, пароль — у файлі-секреті.
 * CLI-процеси (демо, воркер) отримують від scripts/with-secrets.sh уже повний
 * URL, як і грейдер під SKIP_VAULT=1; тоді файл не читається.
 */
export async function withRedisPassword(url: string, passwordFile: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.password) return url;
  parsed.password = encodeURIComponent((await readFile(path.resolve(passwordFile), 'utf8')).trim());
  return parsed.toString();
}

/**
 * Дочекатися готовності клієнта. Потрібно CLI-процесам: з `enableOfflineQueue:
 * false` команда до `ready` падає одразу. Помилка автентифікації чи «connection
 * refused» тут стає винятком із назвою причини, а не тихими повторами в лозі.
 */
export function untilReady(client: Redis, timeoutMs = 5_000): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Redis не відповів за ${timeoutMs} мс`)), timeoutMs);
    const onReady = () => finish();
    const onError = (err: Error) => finish(err);
    function finish(err?: Error): void {
      clearTimeout(timer);
      client.off('ready', onReady);
      client.off('error', onError);
      if (err) reject(err);
      else resolve();
    }
    client.once('ready', onReady);
    client.once('error', onError);
  });
}

/**
 * Два зʼєднання застосунку — по одному на інстанс Redis:
 *   cache — maxmemory + allkeys-lru, копія даних із Postgres (кеш карток);
 *   queue — noeviction + AOF: сесії, вікна rate-limit, продюсер черги.
 *
 * Будь-якого може не бути (порожня змінна) — тоді фічі, що від нього залежать,
 * вимкнені, а не падають. Так ходять тести.
 *
 * Старт чекає на `ready` до STARTUP_WAIT_MS. Без цього перші запити після
 * деплою приходили б раніше за зʼєднання, і з `enableOfflineQueue: false`
 * кожен із них ішов би без сесії й повз кеш — demo:session піймав це як
 * «сесія не пережила рестарт». Redis так і не відповів — стартуємо без нього:
 * лежачий кеш не причина не піднімати API.
 */
const STARTUP_WAIT_MS = 3_000;

export class RedisConnections implements OnApplicationShutdown {
  private static readonly logger = new Logger('Redis');

  constructor(
    readonly cache?: Redis,
    readonly queue?: Redis,
  ) {}

  static async fromConfig(config: ConfigService<Env, true>): Promise<RedisConnections> {
    const passwordFile = config.get('REDIS_PASSWORD_FILE', { infer: true });
    const open = async (url: string | undefined, name: string): Promise<Redis | undefined> => {
      if (!url) {
        RedisConnections.logger.log(`${name}: адресу не задано — вимкнено`);
        return undefined;
      }
      const client = new Redis(await withRedisPassword(url, passwordFile), {
        ...REQUEST_PATH_OPTIONS,
        connectionName: `marketplace-api:${name}`,
      });
      watch(client, name);
      await untilReady(client, STARTUP_WAIT_MS).catch(() => undefined);
      return client;
    };
    return new RedisConnections(
      await open(config.get('REDIS_CACHE_URL', { infer: true }), 'cache'),
      await open(config.get('REDIS_QUEUE_URL', { infer: true }), 'queue'),
    );
  }

  /**
   * Після закриття HTTP-сервера, а не в onModuleDestroy: запити, що
   * дороблюються під час зупинки, ще можуть читати кеш і сесії.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.cache, this.queue].map((client) => client?.quit().catch(() => undefined)));
  }
}

/**
 * Лог лише на зміні стану. ioredis кидає 'error' на КОЖНУ невдалу спробу
 * перепідключення — без цього фільтра лежачий Redis засипав би лог рядком
 * раз на кілька сотень мілісекунд.
 */
function watch(client: Redis, name: string): void {
  const logger = new Logger(`Redis:${name}`);
  let down = false;
  client.on('error', (err: Error) => {
    if (down) return;
    down = true;
    logger.warn(`${err.message} — працюю без нього, перепідключаюсь`);
  });
  client.on('ready', () => {
    if (down) logger.log('знову доступний');
    down = false;
  });
}
