import * as amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel, Message } from 'amqplib';
import { EVENTS_EXCHANGE } from './topology';

export interface DomainEvent {
  eventId: string;
  type: string;
  occurredAt: string;
}

/** Брокер прийняв повідомлення, але жоден binding його не забрав. */
export class UnroutableError extends Error {
  override readonly name = 'UnroutableError';
}

const CONNECT_TIMEOUT_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Публікація подій домену в `shop.events`. Без Nest: той самий клас бере і
 * застосунок (src/orders/order-placed.publisher.ts), і демо.
 *
 * «Опублікував» тут означає «брокер узяв відповідальність», а не «віддав у
 * сокет». Дві речі разом:
 *
 *   • confirm-канал — `publish` чекає basic.ack від брокера. Для persistent
 *     повідомлення в quorum-черзі ack приходить після того, як більшість
 *     реплік записала його на диск;
 *
 *   • `mandatory: true` — бо ack сам по собі не означає «кудись доїхало».
 *     Повідомлення, яке не збіглося з жодним binding, брокер коректно викидає
 *     і ПІДТВЕРДЖУЄ: його відповідальність була викинути правильно. З
 *     mandatory перед цим ack приходить basic.return — перевірено на 4.2.9:
 *     «return → ack». За ним ми й відрізняємо «прийнято» від «викинуто».
 *
 * Топологію клас не оголошує і черг не знає — лише exchange і routing key.
 */
export class EventPublisher {
  private channel?: Promise<ConfirmChannel>;
  private connection?: ChannelModel;
  /** messageId повідомлень, що повернулись через basic.return, — до їхнього confirm. */
  private readonly returned = new Set<string>();

  /** URL — функцією: пароль читається з файла на кожне НОВЕ зʼєднання. */
  constructor(private readonly url: () => Promise<string>) {}

  async publish(event: DomainEvent): Promise<void> {
    const ch = await this.open();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`немає confirm від брокера за ${CONFIRM_TIMEOUT_MS} мс`)), CONFIRM_TIMEOUT_MS);
      ch.publish(
        EVENTS_EXCHANGE,
        event.type,
        Buffer.from(JSON.stringify(event)),
        {
          // persistent — на диск; для quorum-черги це й так єдиний режим, але
          // для classic-підписника, якщо він колись зʼявиться, — ні.
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          messageId: event.eventId,
          type: event.type,
          timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
        },
        (err) => {
          clearTimeout(timer);
          if (err) return reject(new Error(`брокер відмовив у прийомі (basic.nack): ${String(err)}`));
          if (this.returned.delete(event.eventId)) {
            return reject(new UnroutableError(`${event.type} ${event.eventId}: жоден binding у ${EVENTS_EXCHANGE} не збігся — повідомлення викинуто`));
          }
          resolve();
        },
      );
    });
  }

  async close(): Promise<void> {
    const ch = await this.channel?.catch(() => undefined);
    this.channel = undefined;
    await ch?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.connection = undefined;
  }

  /**
   * Ліниве зʼєднання, як у OrmService: застосунок стартує й оформлює
   * замовлення навіть із лежачим брокером. Невдача не кешується — наступна
   * публікація спробує знову.
   */
  private open(): Promise<ConfirmChannel> {
    this.channel ??= this.connect().catch((err: unknown) => {
      this.channel = undefined;
      throw err;
    });
    return this.channel;
  }

  private async connect(): Promise<ConfirmChannel> {
    const connection = await amqp.connect(await this.url(), { timeout: CONNECT_TIMEOUT_MS });
    const ch = await connection.createConfirmChannel();

    ch.on('return', (msg: Message) => {
      if (typeof msg.properties.messageId === 'string') this.returned.add(msg.properties.messageId);
    });

    // Слухачі 'error' обовʼязкові. Помилка каналу (скажімо, 404 NOT_FOUND —
    // exchange ще ніхто не оголосив) — це 'error' на EventEmitter, і без
    // слухача Node кидає її як виняток: падав би весь процес API, а не одна
    // публікація. Після 'close' наступний publish відкриє нове зʼєднання.
    const forget = () => {
      if (this.connection === connection) {
        this.channel = undefined;
        this.connection = undefined;
        this.returned.clear();
      }
    };
    connection.on('error', () => undefined);
    ch.on('error', () => undefined);
    connection.on('close', forget);
    ch.on('close', () => {
      forget();
      void connection.close().catch(() => undefined);
    });

    this.connection = connection;
    return ch;
  }
}
