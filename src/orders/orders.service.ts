import { Injectable } from '@nestjs/common';
import { checkout, CheckoutError } from '../checkout/checkout';
import { HttpProblem } from '../common/http-problem';
import type { Page } from '../common/cursor';
import { OrmService } from '../db/orm.service';
import type { OrderStatus } from '../entities/order.entity';
import { UsersRepository } from '../users/users.repository';
import { OrderEventsService } from './order-events.service';
import { OrdersRepository, type Order } from './orders.repository';

export interface CreateOrderItem {
  product_id: number;
  qty: number;
}

/**
 * З якого статусу можна прийти в кожен. Попередник у кожного рівно один, тому
 * перехід — це одна умова в UPDATE, а не перелік дозволених пар. `pending`
 * тут немає: у нього не повертаються. `cancelled` — лише з `pending`: після
 * оплати скасування означало б refund, а його в сервісі немає (README, розділ 4).
 */
const PREVIOUS: Partial<Record<OrderStatus, OrderStatus>> = {
  paid: 'pending',
  packed: 'paid',
  shipped: 'packed',
  delivered: 'shipped',
  cancelled: 'pending',
};

/**
 * Власник усіх замовлень v1. Авторизації поки немає (`security: []` у спеці),
 * і тіло `CreateOrder` покупця не містить свідомо — інакше клієнт міг би
 * оформлювати від чужого імені. На #24 id прийде з токена, і цей рядок зникне.
 */
const GUEST_BUYER_EMAIL = 'guest@marketplace.local';

@Injectable()
export class OrdersService {
  private guestBuyerId?: Promise<string>;

  constructor(
    private readonly orders: OrdersRepository,
    private readonly users: UsersRepository,
    private readonly orm: OrmService,
    private readonly events: OrderEventsService,
  ) {}

  page(limit: number, cursor?: string): Promise<Page<Order>> {
    return this.orders.page(limit, cursor);
  }

  find(id: number): Promise<Order | null> {
    return this.orders.findById(id);
  }

  /**
   * Та сама транзакція, що й у демо #14: декремент stock, знімок цін,
   * order_items і задача на чек — або все, або нічого. Відповідь читається
   * вже після COMMIT, тим самим репозиторієм, що й GET: форма створеного
   * замовлення не може розійтися з формою прочитаного.
   */
  async create(items: CreateOrderItem[]): Promise<Order> {
    const dataSource = await this.orm.get();
    const buyerId = await this.guestBuyer();

    let orderId: string;
    try {
      ({ orderId } = await checkout(dataSource, {
        buyerId,
        lines: items.map((item) => ({ productId: String(item.product_id), qty: item.qty })),
      }));
    } catch (err) {
      if (err instanceof CheckoutError) throw toProblem(err);
      throw err;
    }

    const order = await this.orders.findById(Number(orderId));
    if (!order) throw new Error(`замовлення ${orderId} закомічене, але не читається`);
    return order;
  }

  /**
   * Перевести замовлення в статус `to`. Подію отримують підписники шини —
   * кімната `orders:<id>` у WebSocket і SSE-потік цього замовлення.
   *
   * Публікація — після COMMIT, і лише коли UPDATE справді змінив рядок.
   * Подія про перехід, який відкотився, пообіцяла б покупцю те, чого немає в
   * базі. UPDATE тут один і без явної транзакції, тож його повернення і є
   * комітом.
   *
   * Повтор того самого статусу — 200 без нової події, як і має бути в PATCH:
   * клієнт, що не дочекався відповіді й повторив запит, не породить другого
   * сповіщення.
   */
  async changeStatus(id: number, to: OrderStatus): Promise<Order> {
    const from = PREVIOUS[to];
    const changed = from !== undefined && (await this.orders.transition(id, from, to));
    if (changed) this.events.publish(id, from, to);

    const order = await this.orders.findById(id);
    if (!order) throw new HttpProblem(404, `замовлення ${id} не існує`, 'not-found');
    if (!changed && order.status !== to) {
      throw new HttpProblem(409, `замовлення ${id} у статусі ${order.status}, перейти в ${to} не можна`, 'conflict');
    }
    return order;
  }

  /** Раз на процес: гість не змінюється, а кожен upsert лишав би мертву версію рядка. */
  private guestBuyer(): Promise<string> {
    this.guestBuyerId ??= this.users.ensureBuyer(GUEST_BUYER_EMAIL).catch((err: unknown) => {
      this.guestBuyerId = undefined;
      throw err;
    });
    return this.guestBuyerId;
  }
}

/**
 * Відмова бізнес-логіки → клас проблеми зі спеки. Слаг мусить бути в `enum`
 * схеми `Problem`, інакше `validateResponses` відкине нашу ж відповідь.
 * Бали й промокоди тіло v1 не передає — ці причини сюди не доходять і
 * падають у загальний 422.
 */
function toProblem(err: CheckoutError): HttpProblem {
  switch (err.reason) {
    case 'unknown_product':
      return new HttpProblem(422, err.message, 'unknown-product');
    // Запит коректний, але суперечить поточному стану товару — 409, а не 422:
    // той самий кошик пройде, щойно продавець поповнить залишок.
    case 'out_of_stock':
      return new HttpProblem(409, err.message, 'conflict');
    case 'invalid_input':
      return new HttpProblem(400, err.message, 'bad-request');
    default:
      return new HttpProblem(422, err.message, 'unprocessable-entity');
  }
}
