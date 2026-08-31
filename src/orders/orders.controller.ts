import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { OrdersService, type CreateOrderItem, type Order } from './orders.service';
import { IdempotencyService } from './idempotency.service';
import { HttpProblem } from '../common/http-problem';
import type { Page } from '../common/cursor';

/** DRIFT=1 — «невинний рефакторинг»: camelCase замість snake_case, currency
 *  загубили, спеку не чіпали. Рівно те, що на лекції ловив contract/check.mjs. */
function view(order: Order): unknown {
  if (process.env.DRIFT !== '1') return order;
  const { total_cents, currency, ...rest } = order;
  return { ...rest, totalCents: total_cents };
}

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService<Order>,
  ) {}

  @Get()
  list(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ): Page<unknown> {
    const page = this.orders.page(limit, cursor);
    return { ...page, items: page.items.map(view) };
  }

  @Get(':orderId')
  one(@Param('orderId', ParseIntPipe) orderId: number): unknown {
    const order = this.orders.find(orderId);
    if (!order) throw new HttpProblem(404, `замовлення ${orderId} не існує`, 'not-found');
    return view(order);
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
        return view(stored);
      }
    }

    this.idempotency.markInFlight(key, fingerprint);
    try {
      // SLOW_MS імітує те, чим на #14 стане транзакція в Postgres: обробник
      // віддає event loop, і саме в цьому вікні другий запит із тим самим
      // ключем бачить стан 'in-flight'. Без затримки гілка 409 недосяжна
      // фізично — синхронний обробник ніколи не переривається.
      const delay = Number(process.env.SLOW_MS ?? 0);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

      const order = this.orders.create(body.items);
      this.idempotency.markDone(key, fingerprint, order);
      res.setHeader('Location', `/v1/orders/${order.id}`);
      return view(order);
    } catch (err) {
      this.idempotency.forget(key);
      throw err;
    }
  }
}
