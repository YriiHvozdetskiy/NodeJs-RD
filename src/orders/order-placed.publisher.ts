import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CheckoutResult } from '../checkout/checkout';
import type { Env } from '../config/env.schema';
import { withBrokerPassword } from '../messaging/broker-url';
import { orderPlacedEvent } from '../messaging/order-placed.event';
import { EventPublisher } from '../messaging/publisher';

/**
 * order.placed з боку застосунку: `OrdersService` викликає `announce` після
 * COMMIT оформлення.
 *
 * ⚠️ Між COMMIT і publish атомарності немає і бути не може: спільного COMMIT
 * у Postgres і RabbitMQ не існує. Процес, що впав між ними, лишає замовлення
 * без події; брокер, що не відповів, — те саме. Тому `announce` не кидає:
 * замовлення вже оформлене, і 500 у відповідь на нього був би неправдою.
 * Невдала публікація — рядок у лозі з eventId. Закриває цю щілину
 * transactional outbox на #22: подія пишеться в ту саму транзакцію, що й
 * замовлення, а в брокер її везе relay.
 */
@Injectable()
export class OrderPlacedPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(OrderPlacedPublisher.name);
  private readonly publisher?: EventPublisher;

  constructor(config: ConfigService<Env, true>) {
    const url = config.get('BROKER_URL', { infer: true });
    const passwordFile = config.get('BROKER_PASSWORD_FILE', { infer: true });
    if (url) {
      this.publisher = new EventPublisher(() => withBrokerPassword(url, passwordFile));
    } else {
      this.logger.log('BROKER_URL не задано — order.placed не публікується');
    }
  }

  async announce(order: CheckoutResult): Promise<void> {
    if (!this.publisher) return;
    const event = orderPlacedEvent(order);
    try {
      await this.publisher.publish(event);
    } catch (err) {
      this.logger.error(
        `order.placed ${event.eventId} (замовлення ${order.orderId}) не опубліковано: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  onModuleDestroy(): Promise<void> | undefined {
    return this.publisher?.close();
  }
}
