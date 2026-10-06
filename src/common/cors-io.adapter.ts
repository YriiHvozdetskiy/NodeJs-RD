import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';

/**
 * socket.io з тим самим списком origin, що й HTTP (`CORS_ORIGINS`).
 *
 * Чому адаптер, а не `@WebSocketGateway({ cors })`: аргумент декоратора
 * обчислюється під час імпорту класу, коли `ConfigService` ще не існує, —
 * туди потрапило б лише сире `process.env` повз zod-схему.
 *
 * CORS тут стосується HTTP-частини socket.io: handshake і long-polling, з
 * якого клієнт стартує. Без `Access-Control-Allow-Origin` браузер з іншого
 * origin не прочитає відповідь на перший же запит, і до апгрейду на WebSocket
 * справа не дійде. Сам WebSocket під CORS не підпадає — його `Origin` сервер
 * міг би перевіряти окремо, але особа клієнта їде в `auth`, а не в cookie, тож
 * чужа сторінка не підключиться від імені покупця, просто відкривши сокет.
 */
export class CorsIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    return super.createIOServer(port, { ...options, cors: { origin: this.origins } });
  }
}
