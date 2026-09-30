import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { concat, defer, endWith, filter, from, ignoreElements, Subject, type Observable } from 'rxjs';
import type { OrderStatus } from '../entities/order.entity';

/** Подія зміни статусу — однакова для WebSocket і SSE. */
export interface OrderStatusEvent {
  /** Номер події в процесі: росте на 1, спільний для всіх замовлень. */
  id: number;
  order_id: number;
  status: OrderStatus;
  previous_status: OrderStatus;
  changed_at: string;
}

/**
 * Скільки останніх подій памʼятає процес для `Last-Event-ID`. Буфер спільний
 * на всі замовлення: памʼять обмежена числом подій, а не числом замовлень, які
 * колись змінювались. Клієнт, що пропустив більше, отримає лише те, що
 * лишилось у буфері.
 */
const BUFFER_SIZE = 1000;

/**
 * Одна шина — два транспорти. `OrdersService` публікує сюди подію після
 * COMMIT; gateway розносить її по кімнатах socket.io, SSE-контролер — у
 * відкриті потоки. Жоден транспорт не знає про інший, і бізнес-логіка не знає
 * про жоден: на #19 між `publish` і підписниками стане RabbitMQ, а
 * `OrdersService` цього не помітить.
 */
@Injectable()
export class OrderEventsService implements OnModuleDestroy {
  private seq = 0;
  private readonly buffer: OrderStatusEvent[] = [];
  private readonly bus = new Subject<OrderStatusEvent>();

  /** Усі події наживо, без історії. */
  readonly events$ = this.bus.asObservable();

  /**
   * Одне значення в момент, коли шина закрилась. Потрібне тим, хто домішує до
   * подій власний таймер (heartbeat у SSE): `interval` сам не завершиться
   * ніколи, і відкрите зʼєднання не дало б застосунку зупинитись.
   */
  readonly closed$: Observable<void> = this.bus.pipe(ignoreElements(), endWith(undefined));

  publish(orderId: number, previous: OrderStatus, status: OrderStatus): OrderStatusEvent {
    const event: OrderStatusEvent = {
      id: ++this.seq,
      order_id: orderId,
      status,
      previous_status: previous,
      changed_at: new Date().toISOString(),
    };
    this.buffer.push(event);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
    this.bus.next(event);
    return event;
  }

  /**
   * Потік одного замовлення: спершу події з номером > `after` із буфера, далі
   * наживо. `after = 0` — уся історія, що є в буфері.
   *
   * `defer` — щоб знімок буфера брався в момент підписки, а не виклику.
   * Щілини між знімком і живим потоком немає: `from` віддає масив синхронно, і
   * `concat` підписується на шину в тому ж тіку — `publish` між ними
   * вклинитись не може, бо це теж синхронний код. Дублів теж: у знімку лише
   * те, що опубліковано ДО підписки, наживо — лише те, що ПІСЛЯ.
   */
  stream(orderId: number, after: number): Observable<OrderStatusEvent> {
    return defer(() =>
      concat(
        from(this.since(orderId, after)),
        this.events$.pipe(filter((event) => event.order_id === orderId)),
      ),
    );
  }

  private since(orderId: number, after: number): OrderStatusEvent[] {
    // Номер більший за будь-який виданий — клієнт памʼятає попередній процес:
    // після рестарту лічильник почався з 1. Віддаємо все, що є, а не нічого —
    // інакше клієнт мовчки чекав би, доки новий лічильник наздожене старий.
    const lastSeen = after > this.seq ? 0 : after;
    return this.buffer.filter((event) => event.order_id === orderId && event.id > lastSeen);
  }

  /**
   * Nest викликає це до закриття HTTP-сервера: відкриті SSE-потоки
   * завершуються, і сервер не чекає на клієнтів, які самі не відключаться
   * ніколи. Виміряно з одним відкритим потоком: без цього рядка процес на
   * SIGTERM не вийшов і за 10 с, з ним — за 5 с. Ці 5 с — `keepAliveTimeout`
   * Node: відповідь уже закінчилась, але зʼєднання ще keep-alive.
   */
  onModuleDestroy(): void {
    this.bus.complete();
  }
}
