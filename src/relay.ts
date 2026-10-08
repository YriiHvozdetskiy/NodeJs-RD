import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { requiredEnv } from './db/cli-env';
import { EventPublisher } from './messaging/publisher';
import { RELAY_BATCH_SIZE, runRelay } from './outbox/relay';

/**
 * Relay outbox окремим процесом (#22). Той самий цикл, що вбудований у
 * застосунок (src/outbox/outbox-relay.service.ts), — для масштабування окремо
 * від API і для demo:crash-relay, якому потрібен relay, що його можна вбити
 * по-справжньому, не вбиваючи разом із ним API.
 *
 *   npm run relay    ≡ bash scripts/with-secrets.sh dev node dist/relay.js
 *
 * Скільки relay не запусти, кожен рядок винесе один: SKIP LOCKED роздає їм
 * різні рядки. Дубль можливий лише після падіння між publish і COMMIT.
 */

/** Що relay повідомляє батьківському процесу демо (IPC). Без демо — нікому. */
export type RelayReport =
  | { t: 'ready'; pid: number; batchSize: number }
  /** Брокер підтвердив ці рядки, UPDATE published_at ще не виконано. */
  | { t: 'published'; ids: string[] }
  /** UPDATE published_at закомічено. */
  | { t: 'committed'; ids: string[] }
  /** Невинесених вільних рядків немає. */
  | { t: 'idle' }
  | { t: 'failed'; error: string; delayMs: number };

/**
 * Пауза між publish і UPDATE — ЛИШЕ для demo:crash-relay, як
 * CONSUMER_ACK_DELAY_MS у споживача. У проді ця щілина — мілісекунди, але вона
 * є завжди. Демо її розширює, щоб влучити SIGKILL-ом детерміновано.
 */
const PAUSE_AFTER_PUBLISH_MS = Number(process.env.RELAY_PAUSE_AFTER_PUBLISH_MS ?? 0);

const report = (r: RelayReport) => process.send?.(r);
const log = (line: string) => console.log(`[relay ${process.pid}] ${line}`);

async function main(): Promise<void> {
  const brokerUrl = requiredEnv('BROKER_URL');
  // Одне зʼєднання: прохід — одна транзакція, паралелі всередині процесу немає.
  const dataSource = await new DataSource({ ...dataSourceOptions, poolSize: 1 }).initialize();
  const publisher = new EventPublisher(async () => brokerUrl);
  const stop = new AbortController();

  const loop = runRelay(async () => dataSource, publisher, {
    signal: stop.signal,
    afterPublish: async (ids) => {
      report({ t: 'published', ids });
      if (PAUSE_AFTER_PUBLISH_MS > 0) {
        log(`брокер підтвердив ${ids.length}, published_at ще NULL — пауза ${PAUSE_AFTER_PUBLISH_MS} мс`);
        await sleep(PAUSE_AFTER_PUBLISH_MS);
      }
    },
    onBatch: ({ claimed, published }) => {
      if (published.length > 0) {
        report({ t: 'committed', ids: published });
        log(`винесено ${published.length}: ${published.join(', ')}`);
      }
      if (claimed === 0) report({ t: 'idle' });
    },
    onError: (error, delayMs) => {
      report({ t: 'failed', error, delayMs });
      log(`${error} — повтор через ${delayMs} мс`);
    },
  });

  report({ t: 'ready', pid: process.pid, batchSize: RELAY_BATCH_SIZE });
  log(`опитую outbox, batch=${RELAY_BATCH_SIZE}`);

  // SIGTERM — коректне завершення: поточний прохід доходить до COMMIT, нового
  // не починаємо. SIGKILL так не вміє — і саме його бере demo:crash-relay.
  const shutdown = async (signal: string) => {
    if (stop.signal.aborted) return;
    log(`${signal}: дороблюю поточний прохід`);
    stop.abort();
    await loop;
    await publisher.close();
    await dataSource.destroy();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(`[relay ${process.pid}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
