import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { interval, map, merge, takeUntil, type Observable } from 'rxjs';
import { GUEST_BUYER_EMAIL, OrdersService, type CreateOrderItem } from './orders.service';
import type { Order } from './orders.repository';
import { IdempotencyService } from './idempotency.service';
import { OrderEventsService } from './order-events.service';
import { HttpProblem } from '../common/http-problem';
import type { Page } from '../common/cursor';
import type { Env } from '../config/env.schema';
import type { OrderStatus } from '../entities/order.entity';

/**
 * Через скільки EventSource перепідключається після обриву. Без цього поля
 * браузер чекає кілька секунд на свій розсуд.
 */
const SSE_RETRY_MS = 1000;

/**
 * Коментар `: ping` у потік. Проксі й балансувальники рвуть зʼєднання, яким
 * нічого не пишуть (nginx — через 60 с), а статус замовлення може не
 * змінюватись годинами. EventSource коментарі ігнорує.
 */
const SSE_HEARTBEAT_MS = 15_000;

/** `Last-Event-ID` — рядок від клієнта; все, що не додатне ціле, означає «з початку буфера». */
function lastEventIdOf(raw: string | undefined): number {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService<Order>,
    private readonly config: ConfigService<Env, true>,
    private readonly events: OrderEventsService,
  ) {}

  /** DRIFT=1 — «невинний рефакторинг»: camelCase замість snake_case, currency
   *  загубили, спеку не чіпали. Рівно те, що на лекції ловив contract/check.mjs.
   *  Прапорець приходить із провалідованого конфігу, а не з сирого оточення:
   *  схема вже перетворила рядок "1" на boolean, і робити це вдруге тут нічим. */
  private view(order: Order): unknown {
    if (!this.config.get('DRIFT', { infer: true })) return order;
    const { total_cents, currency, ...rest } = order;
    return { ...rest, totalCents: total_cents };
  }

  @Get()
  async list(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ): Promise<Page<unknown>> {
    const page = await this.orders.page(limit, cursor);
    return { ...page, items: page.items.map((order) => this.view(order)) };
  }

  @Get(':orderId')
  async one(@Param('orderId', ParseIntPipe) orderId: number): Promise<unknown> {
    const order = await this.orders.find(orderId);
    if (!order) throw new HttpProblem(404, `замовлення ${orderId} не існує`, 'not-found');
    return this.view(order);
  }

  /**
   * Тіло перевіряє валідатор спеки (схема `OrderStatusChange`): сюди доходить
   * лише статус з `enum`. Чи дозволений перехід — питання вже не форми, а
   * стану, тому його вирішує сервіс.
   */
  @Patch(':orderId')
  async changeStatus(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() body: { status: OrderStatus },
  ): Promise<unknown> {
    return this.view(await this.orders.changeStatus(orderId, body.status));
  }

  /**
   * SSE-потік змін статусу — `GET /orders/:id/events`, поза `/v1`
   * (src/app.setup.ts): це не JSON-ресурс контракту, OpenAPI 3.0 потік подій
   * не описує, і валідатор спеки його не бачить.
   *
   * Nest пише кожне значення як блок `event:` / `id:` / `data:` і
   * відписується від Observable, коли клієнт закриває зʼєднання, — підписка
   * на шину не переживає клієнта.
   *
   * Реконект — робота EventSource: після обриву він сам надсилає
   * `Last-Event-ID` з останнім отриманим `id:`, і потік дограє з буфера лише
   * те, що новіше. Без заголовка — вся історія цього замовлення, що є в
   * буфері: новий клієнт одразу бачить, де замовлення зараз.
   */
  @Sse(':orderId/events')
  async statusEvents(
    @Param('orderId', ParseIntPipe) orderId: number,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<Observable<MessageEvent>> {
    // Та сама перевірка власника, що й на WS-`join`. Особа HTTP-запиту v1 —
    // гість: від його імені `POST /v1/orders` оформлює замовлення, тож свої
    // замовлення він слухає без креденшелів, а чужі — ні. Власного заголовка
    // EventSource не надішле, тому до #24 явної особи тут немає; тоді гостя
    // замінить JWT із cookie.
    //
    // Чуже й неіснуюче — однакові 404: відповідь не підтверджує, що чуже
    // замовлення існує. І все це до першого байта потоку, поки заголовки ще не
    // надіслані, — відмова приходить звичайним problem+json.
    if (!(await this.orders.isOwnedBy(orderId, GUEST_BUYER_EMAIL))) {
      throw new HttpProblem(404, `замовлення ${orderId} не існує`, 'not-found');
    }

    // `retry:` їде в кожному блоці події, а не окремим першим блоком. Nest
    // нумерує сам кожне повідомлення без `id`, крім коментарів: блок з одним
    // `retry` вийшов би як `id: 1`, EventSource запамʼятав би 1 як останню
    // подію, і після реконекту `Last-Event-ID: 1` дограв би вже отримане.
    // Заголовки від цього не чекають першої події — Nest 11 відправляє їх
    // одразу після підписки.
    const events$ = this.events.stream(orderId, lastEventIdOf(lastEventId)).pipe(
      map((event): MessageEvent => ({
        id: String(event.id),
        type: 'order.status',
        retry: SSE_RETRY_MS,
        data: event,
      })),
    );
    const heartbeat$ = interval(SSE_HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ comment: 'ping' })),
      takeUntil(this.events.closed$),
    );
    return merge(events$, heartbeat$);
  }

  /**
   * Зверни увагу: жодного `if` на наявність `Idempotency-Key`. Заголовок
   * вимагає СПЕКА (`required: true`), і валідатор відкидає запит без нього до
   * входу в цей метод. Вимогу неможливо забути разом із перевіркою — її просто
   * немає в коді, щоб забути.
   */
  @Post()
  @HttpCode(201)
  async create(
    @Headers('idempotency-key') key: string,
    @Body() body: { items: CreateOrderItem[] },
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const fingerprint = this.idempotency.fingerprint(body);
    const entry = this.idempotency.get(key);

    switch (this.idempotency.decide(entry, fingerprint)) {
      case 'in-flight':
        throw new HttpProblem(409, 'запит із цим Idempotency-Key ще опрацьовується', 'idempotency-key-in-flight');
      case 'mismatch':
        throw new HttpProblem(422, 'цей Idempotency-Key вже використано з іншим тілом запиту', 'idempotency-key-reused');
      case 'replay': {
        // Обробник НЕ виконується — у цьому вся гарантія: другого замовлення
        // й другого списання не буде.
        const stored = entry!.response!;
        res.setHeader('Idempotency-Replay', 'true');
        res.setHeader('Location', `/v1/orders/${stored.id}`);
        return this.view(stored);
      }
    }

    this.idempotency.markInFlight(key, fingerprint);
    try {
      // SLOW_MS розширює вікно, у якому обробник віддає event loop. Тепер,
      // коли тут справжня транзакція в Postgres, вікно існує й без нього, але
      // триває мілісекунди — для демо гілки 409 'in-flight' замало.
      const delay = this.config.get('SLOW_MS', { infer: true });
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

      const order = await this.orders.create(body.items);
      this.idempotency.markDone(key, fingerprint, order);
      res.setHeader('Location', `/v1/orders/${order.id}`);
      return this.view(order);
    } catch (err) {
      this.idempotency.forget(key);
      throw err;
    }
  }
}
