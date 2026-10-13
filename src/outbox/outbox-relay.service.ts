import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { OrmService } from '../db/orm.service';
import { withBrokerPassword } from '../messaging/broker-url';
import { EventPublisher } from '../messaging/publisher';
import { runRelay } from './relay';

/**
 * Relay outbox усередині застосунку (#22) — замість публікації після COMMIT
 * з #19. Checkout лише пише подію в outbox своєю транзакцією, а цей цикл
 * виносить її в брокер. Тож `npm run start` доносить order.placed до
 * споживача без жодного додаткового процесу.
 *
 * Кожен інстанс API має свій relay, і всі вони опитують одну таблицю. Двічі
 * той самий рядок вони не візьмуть — це робота SKIP LOCKED (src/outbox/relay.ts).
 *
 * Без BROKER_URL цикл не стартує: подія лягає в outbox і чекає. Так ходять
 * тести, а винести накопичене можна будь-коли — `npm run relay`.
 *
 * Зупинка: Nest викликає onModuleDestroy у зворотному порядку ініціалізації,
 * тож цей провайдер (AppModule) зупиняється раніше, ніж DbModule закриє пул.
 * Поточний прохід доходить до COMMIT.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRelay');
  private readonly publisher?: EventPublisher;
  private readonly stop = new AbortController();
  private loop?: Promise<void>;

  constructor(
    config: ConfigService<Env, true>,
    private readonly orm: OrmService,
  ) {
    const url = config.get('BROKER_URL', { infer: true });
    const passwordFile = config.get('BROKER_PASSWORD_FILE', { infer: true });
    if (url) {
      this.publisher = new EventPublisher(() => withBrokerPassword(url, passwordFile));
    } else {
      this.logger.log('BROKER_URL не задано — події лишаються в outbox до `npm run relay`');
    }
  }

  onApplicationBootstrap(): void {
    if (!this.publisher) return;
    this.loop = runRelay(() => this.orm.get(), this.publisher, {
      signal: this.stop.signal,
      onBatch: ({ published }) => {
        if (published.length > 0) this.logger.log(`винесено ${published.length} подій з outbox`);
      },
      // Лежачий брокер чи база — не причина валити API: замовлення
      // оформлюються, події чекають у outbox, relay повторює з паузою.
      onError: (error, delayMs) => this.logger.warn(`${error} — повтор через ${delayMs} мс`),
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stop.abort();
    await this.loop;
    await this.publisher?.close();
  }
}
