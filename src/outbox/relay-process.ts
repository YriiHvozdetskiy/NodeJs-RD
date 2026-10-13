import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../data-source';
import { requiredEnv } from '../db/cli-env';
import type { MessageSender } from '../messaging/publisher';
import { RELAY_BATCH_SIZE, RELAY_LEASE_MS, runRelay } from './relay';

/**
 * Relay outbox окремим процесом: `npm run relay` (src/relay.ts) і дочірній
 * relay demo:crash-relay (src/demo-relay.ts). Різняться лише відправником —
 * справжній EventPublisher чи двійник, що тримає паузу після confirm.
 */

/** Що relay повідомляє батьківському процесу демо (IPC). Без демо — нікому. */
export type RelayReport =
  | { t: 'ready'; pid: number; batchSize: number; leaseMs: number }
  /** Брокер підтвердив подію, позначки published_at ще немає. Шле лише двійник демо. */
  | { t: 'published'; id: string }
  /** UPDATE published_at закомічено. */
  | { t: 'committed'; ids: string[] }
  /** Невинесених вільних рядків немає. */
  | { t: 'idle' }
  | { t: 'failed'; error: string; delayMs: number };

export const reportToParent = (r: RelayReport) => process.send?.(r);
export const relayLog = (line: string) => console.log(`[relay ${process.pid}] ${line}`);

export async function runRelayProcess(makeSender: (brokerUrl: string) => MessageSender, { leaseMs = RELAY_LEASE_MS } = {}): Promise<void> {
  const brokerUrl = requiredEnv('BROKER_URL');
  // Одне зʼєднання: оператори проходу йдуть по черзі, паралелі всередині процесу немає.
  const dataSource = await new DataSource({ ...dataSourceOptions, poolSize: 1 }).initialize();
  const sender = makeSender(brokerUrl);
  const stop = new AbortController();

  const loop = runRelay(async () => dataSource, sender, {
    signal: stop.signal,
    leaseMs,
    onBatch: ({ claimed, published }) => {
      if (published.length > 0) {
        reportToParent({ t: 'committed', ids: published });
        relayLog(`винесено ${published.length}: ${published.join(', ')}`);
      }
      if (claimed === 0) reportToParent({ t: 'idle' });
    },
    onError: (error, delayMs) => {
      reportToParent({ t: 'failed', error, delayMs });
      relayLog(`${error} — повтор через ${delayMs} мс`);
    },
  });

  reportToParent({ t: 'ready', pid: process.pid, batchSize: RELAY_BATCH_SIZE, leaseMs });
  relayLog(`опитую outbox, batch=${RELAY_BATCH_SIZE}, оренда ${leaseMs} мс`);

  // SIGTERM — коректне завершення: поточний прохід доходить до позначки, нового
  // не починаємо. SIGKILL так не вміє — і саме його бере demo:crash-relay.
  const shutdown = async (signal: string) => {
    if (stop.signal.aborted) return;
    relayLog(`${signal}: дороблюю поточний прохід`);
    stop.abort();
    await loop;
    await sender.close();
    await dataSource.destroy();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
