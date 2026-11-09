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
import { AccessDenylist } from '../auth/access-denylist';
import { AccessTokens, type Principal } from '../auth/access-tokens';

/** Відповідь на `join` — те, що клієнт отримує в ack. */
export type JoinAck =
  | { ok: true; room: string }
  | { ok: false; error: 'bad-request' | 'unauthorized' | 'forbidden' };

export const roomOf = (orderId: number): string => `orders:${orderId}`;

/**
 * Access-токен із handshake: `io(url, { auth: { token } })`. Не з query-рядка:
 * URL із токеном осідає в логах проксі й в історії, а `auth` їде тілом
 * першого пакета socket.io.
 */
function tokenOf(socket: Socket): string | undefined {
  const token: unknown = socket.handshake.auth?.token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
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
    private readonly tokens: AccessTokens,
    private readonly denylist: AccessDenylist,
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

    const principal = await this.principalOf(socket);
    if (!principal) {
      this.logger.warn(`${socket.id}: join ${roomOf(orderId)} без чинного токена — відмова`);
      return { ok: false, error: 'unauthorized' };
    }
    // Ті самі два рівні, що в HTTP: «хто це» — вище, «чи його це замовлення» —
    // тут, по buyer_id прочитаного рядка. Неіснуюче й чуже — однаково forbidden:
    // кімнати неіснуючого замовлення однаково ніхто не почує.
    const found = await this.orders.findWithBuyer(orderId);
    if (!found || (found.buyerId !== principal.userId && principal.role !== 'admin')) {
      this.logger.warn(`${socket.id}: user=${principal.userId} → ${roomOf(orderId)} — не власник, відмова`);
      return { ok: false, error: 'forbidden' };
    }

    // Кімнату сокет покидає сам при відключенні — окремого leave для цього
    // не треба.
    await socket.join(roomOf(orderId));
    this.logger.log(`${socket.id}: user=${principal.userId} → ${roomOf(orderId)}`);
    return { ok: true, room: roomOf(orderId) };
  }

  /**
   * Той самий контроль, що в AuthGuard: підпис, exp, денилист. На кожен
   * `join`, а не раз на handshake: сокет живе годинами, а токен — 10 хвилин,
   * і логаут має закривати й нові підписки.
   */
  private async principalOf(socket: Socket): Promise<Principal | undefined> {
    const token = tokenOf(socket);
    if (!token) return undefined;
    try {
      const principal = await this.tokens.verify(token);
      return (await this.denylist.isRevoked(principal)) ? undefined : principal;
    } catch {
      return undefined;
    }
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }
}
