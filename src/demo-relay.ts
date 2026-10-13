import { setTimeout as sleep } from 'node:timers/promises';
import { EventPublisher, type MessageSender, type OutgoingMessage } from './messaging/publisher';
import { relayLog, reportToParent, runRelayProcess } from './outbox/relay-process';

/**
 * Relay для demo:crash-relay — дочірній процес, якого демо вбиває kill -9.
 *
 * Цикл той самий, що в `npm run relay`. Різниця одна — тестовий двійник
 * відправника: справжній publish, а після confirm брокера — звіт демо й
 * пауза. Relay стоїть рівно між publish і UPDATE published_at, поки демо його
 * не вбʼє. У проді вікно між ними — мілісекунди, але воно є завжди; двійник
 * розширює його, щоб влучити детерміновано. У робочому relay такої точки немає.
 *
 * Оренда коротка (2 с замість 30): після вбивства рядок має повернутись до
 * другого relay за секунди, а не за пів хвилини.
 */
const PAUSE_AFTER_CONFIRM_MS = 10_000;
const DEMO_LEASE_MS = 2_000;

class PausingSender implements MessageSender {
  constructor(private readonly inner: MessageSender) {}

  async send(message: OutgoingMessage): Promise<void> {
    await this.inner.send(message);
    reportToParent({ t: 'published', id: message.messageId });
    relayLog(`брокер підтвердив ${message.messageId}, published_at ще NULL — пауза ${PAUSE_AFTER_CONFIRM_MS} мс`);
    await sleep(PAUSE_AFTER_CONFIRM_MS);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

runRelayProcess((brokerUrl) => new PausingSender(new EventPublisher(async () => brokerUrl)), { leaseMs: DEMO_LEASE_MS }).catch(
  (err: unknown) => {
    console.error(`[relay ${process.pid}] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
