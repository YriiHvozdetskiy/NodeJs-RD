import type * as http from 'node:http';

import { getRequestId } from '../context/request-context';
import { HttpError } from '../errors';

/**
 * Останній рубіж: перетворює будь-яку помилку з циклу на HTTP-відповідь.
 *
 * «Будь-яку» — буквально. Він стоїть на найвищому рівні й ловить те, що кинув
 * обробник, pipe, guard і навіть interceptor. Якщо помилка проскочить повз
 * нього, Node просто обірве сокет: клієнт побачить не 500, а розрив зʼєднання,
 * і не дізнається взагалі нічого.
 *
 * Дві категорії, і межа між ними принципова:
 *
 *   HttpError — очікуване. Ми самі його кинули, знаємо статус і що сказати
 *   клієнту. Віддаємо як є.
 *
 *   Усе інше — наш баг. Клієнту йде рівне 500 без подробиць, а справжня
 *   причина лишається в логах. Це не параноя: у тексті помилки бувають шляхи
 *   на диску, SQL-запити, імена таблиць і фрагменти конфігу. Стек-трейс
 *   назовні — це готова карта застосунку для того, хто її шукає.
 */
export function exceptionFilter(res: http.ServerResponse, error: unknown): void {
  // Заголовки вже пішли — відповідь почалась, і змінити статус фізично
  // неможливо. Лишається обірвати зʼєднання, інакше клієнт чекатиме вічно.
  if (res.headersSent) {
    res.destroy();
    return;
  }

  const payload = toPayload(error);

  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(payload.statusCode as number, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  res.end(body);
}

function toPayload(error: unknown): Record<string, unknown> {
  const requestId = getRequestId();

  if (error instanceof HttpError) {
    // requestId у тілі — щоб користувач міг назвати його підтримці, а та
    // знайшла за ним увесь ланцюг у логах.
    return { ...error.toResponse(), requestId };
  }

  // Логуємо ПОВНІСТЮ — з requestId, тож у логах цей рядок зшивається
  // з рядком interceptor'а по тому самому id.
  console.error(`[filter] ${requestId ?? 'no-request-id'} необроблена помилка:`, error);

  return { statusCode: 500, message: 'Internal Server Error', requestId };
}
