import { Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayInit,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';
import { OrderEventsService } from './order-events.service';
import { OrdersRepository } from './orders.repository';

/** Відповідь на `join` — те, що клієнт отримує в ack. */
export type JoinAck =
  | { ok: true; room: string }
  | { ok: false; error: 'bad-request' | 'unauthorized' | 'forbidden' };

export const roomOf = (orderId: number): string => `orders:${orderId}`;

/**
 * Хто підключився. До #24 клієнт називає себе сам — `io(url, { auth: { email } })`
 * у handshake. Це декларація, а не доказ; але перевірка власника вже стоїть
 * там, де на #24 стане перевірка JWT, і `join` від цього не зміниться.
 */
function emailOf(socket: Socket): string | undefined {
  const email: unknown = socket.handshake.auth?.email;
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

/** Тіло `join` — `{ order_id: 42 }`. Валідатора спеки тут немає, перевіряємо самі. */
function orderIdOf(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null || !('order_id' in body)) return undefined;
  const id = body.order_id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Той самий порт, що й HTTP: без аргументів gateway чіпляється до сервера
 * Express, і socket.io перехоплює лише шлях `/socket.io/`. Тому ні префікс
 * `/v1`, ні валідатор спеки цих запитів не бачать.
 */
@WebSocketGateway()
export class OrdersGateway implements OnGatewayInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersGateway.name);
  private subscription?: Subscription;

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly events: OrderEventsService,
    private readonly orders: OrdersRepository,
  ) {}

  /**
   * Одна підписка на шину на весь процес, а не на кожен сокет. Хто що чує,
   * вирішує кімната: `to(room)` віддає подію лише сокетам, які пройшли `join`
   * для цього замовлення. `server.emit` без `to` почули б усі підключені —
   * рівно те, що ловить `scripts/realtime-demo.mjs`.
   */
  afterInit(): void {
    this.subscription = this.events.events$.subscribe((event) => {
      this.server.to(roomOf(event.order_id)).emit('order.status', event);
    });
  }

  /**
   * Повернене значення Nest віддає в ack клієнта. Відмова — теж відповідь, а
   * не виняток: `WsException` пішов би окремою подією `exception`, і клієнт,
   * що чекає ack, так і не дочекався б.
   */
  @SubscribeMessage('join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<JoinAck> {
    const orderId = orderIdOf(body);
    if (orderId === undefined) return { ok: false, error: 'bad-request' };

    const email = emailOf(socket);
    if (!email) {
      this.logger.warn(`${socket.id}: join ${roomOf(orderId)} без email — відмова`);
      return { ok: false, error: 'unauthorized' };
    }
    if (!(await this.orders.isOwnedBy(orderId, email))) {
      this.logger.warn(`${socket.id}: ${email} → ${roomOf(orderId)} — не власник, відмова`);
      return { ok: false, error: 'forbidden' };
    }

    // Кімнату сокет покидає сам при відключенні — окремого leave для цього
    // не треба.
    await socket.join(roomOf(orderId));
    this.logger.log(`${socket.id}: ${email} → ${roomOf(orderId)}`);
    return { ok: true, room: roomOf(orderId) };
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }
}
