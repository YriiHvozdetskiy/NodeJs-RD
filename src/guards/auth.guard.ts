import { Injectable } from '../decorators/injectable';
import { ForbiddenError } from '../errors';
import type { CanActivate, LifecycleContext } from '../types';

/**
 * Пускає далі лише запити із заголовком `Authorization: Bearer <token>`.
 *
 * Guard — найперший шар після middleware, і він виконується ДО валідації.
 * Порядок не косметичний: немає сенсу розбирати й перевіряти тіло запиту,
 * який усе одно не пустять. Це заразом дешевий захист від навантаження —
 * невалідний запит відсікається до найдорожчої роботи.
 *
 * Повертає `boolean`, а не кидає помилку, — так вимагає постановка й так
 * влаштований `CanActivate` у Nest. Перетворити `false` на 403 — робота
 * диспетчера, а не guard'а: guard відповідає на питання «пускати?», а не
 * «яку відповідь віддати».
 *
 * `@Injectable()` тут обовʼязковий: guard створює контейнер, тож у нього
 * можна інжектити сервіси (реальний ходив би в базу за сесією).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(ctx: LifecycleContext): boolean {
    const header = ctx.headers.authorization;

    if (typeof header !== 'string') {
      return false;
    }

    // Схему перевіряємо явно: `Authorization: hunter2` — це не Bearer-токен,
    // і пропускати його лише за фактом наявності заголовка не можна.
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' && typeof token === 'string' && token.length > 0;
  }
}

/**
 * Той самий guard, але кидає помилку з поясненням замість голого false.
 *
 * Тримаємо поруч, щоб було видно різницю в поведінці: `false` дає рівний
 * 403 без подробиць, а кинутий ForbiddenError доносить причину до клієнта
 * через exception filter. Обидва варіанти легальні; другий зручніший, коли
 * причин відмови кілька.
 */
@Injectable()
export class StrictAuthGuard implements CanActivate {
  canActivate(ctx: LifecycleContext): boolean {
    if (typeof ctx.headers.authorization !== 'string') {
      throw new ForbiddenError('Потрібен заголовок Authorization');
    }
    return true;
  }
}
