import 'reflect-metadata';

import * as http from 'node:http';

import type { Container } from './container';
import { ValidationFailedError, validateBody } from './pipes/validation.pipe';
import { collectRoutes, matchRoute } from './router';
import type { Constructor, Route } from './types';

/** Стеля розміру тіла. Без неї один клієнт кладе процес, надіславши потік без кінця. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Типи, які приходять у `design:paramtypes` для НЕ-DTO аргументів.
 *
 * `@Param('id') id: string` дасть `String`, а `@Body() body: unknown` — `Object`.
 * Валідувати за ними нема чого: правил на них ніхто не вішав.
 */
const NON_DTO_TYPES: readonly unknown[] = [Object, String, Number, Boolean, Array, Function];

function isDtoClass(type: unknown): type is Constructor<object> {
  return typeof type === 'function' && !NON_DTO_TYPES.includes(type);
}

/** Тіло прийшло невалідним JSON — це помилка клієнта, не сервера. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/**
 * Збирає тіло запиту з чанків.
 *
 * Це той самий код, що на Лекції 3, і причина та сама: `node:http` не парсить
 * тіло. У браузері `await res.json()` ховав цей крок, на сервері він ваш.
 *
 * Три деталі, які легко пропустити:
 *   - чанки — це `Buffer`, не рядки. Склеювати через `+=` не можна: символ
 *     у UTF-8 буває на межі двох чанків і розвалиться на «пʼять» байтів;
 *   - тому `Buffer.concat` спершу, `toString('utf8')` — потім;
 *   - лічильник байтів, а не довжина рядка: `Content-Length` теж у байтах,
 *     і «привіт» — це 6 символів, але 12 байтів.
 */
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // destroy, а не просто reject: інакше клієнт спокійно доллє решту
        // мегабайтів, і памʼять ми вже витратимо.
        req.destroy();
        reject(new BadRequestError(`Тіло запиту більше за ліміт ${MAX_BODY_BYTES} байтів`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', reject);

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BadRequestError('Тіло запиту не є валідним JSON'));
      }
    });
  });
}

/** Усе, що диспетчер знає про поточний запит, коли будує аргументи. */
interface RequestContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

/**
 * Будує масив аргументів хендлера за мапою параметр-декораторів.
 *
 * Ітеруємо по ІНДЕКСАХ, а не по мапі: мапа розріджена, і якщо будувати список
 * із її ключів, аргумент без декоратора просто зникне, а всі наступні зʼїдуть
 * на позицію вліво. Кількість аргументів задає `design:paramtypes`.
 *
 * Функція асинхронна — і це головна відмінність від `resolve` з частини 1.
 * Там граф збирався синхронно, бо всі залежності вже були в памʼяті. Тут
 * посередині стоїть валідація DTO, а вона повертає проміс.
 */
async function buildArgs(route: Route, ctx: RequestContext): Promise<unknown[]> {
  const indexes = Object.keys(route.params).map(Number);
  const arity = Math.max(route.paramTypes.length, ...indexes.map((i) => i + 1), 0);

  const args: unknown[] = new Array(arity).fill(undefined);

  for (let index = 0; index < arity; index += 1) {
    const meta = route.params[index];
    if (meta === undefined) {
      // Аргумент без декоратора лишається undefined. Це не помилка:
      // хендлер міг оголосити його з дефолтним значенням.
      continue;
    }

    switch (meta.source) {
      case 'param':
        args[index] = meta.name === undefined ? ctx.params : ctx.params[meta.name];
        break;

      case 'query':
        // `?? undefined` навмисно: URLSearchParams.get віддає null, а
        // дефолтне значення аргументу (`limit = 10`) спрацьовує лише на undefined.
        args[index] = meta.name === undefined ? ctx.query : (ctx.query.get(meta.name) ?? undefined);
        break;

      case 'body': {
        const declared = route.paramTypes[index];
        // Пайп вмикається САМ, якщо тип аргументу — клас DTO. Це те, що в Nest
        // робить глобальний ValidationPipe: окремо його тут вішати не треба.
        args[index] = isDtoClass(declared) ? await validateBody(declared, ctx.body) : ctx.body;
        break;
      }
    }
  }

  return args;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    // У БАЙТАХ, не в символах — інакше відповідь із кирилицею обріжеться
    // рівно посередині, і клієнт зависне, чекаючи решту.
    'content-length': body.length,
  });
  res.end(body);
}

/**
 * Робить із таблиці маршрутів обробник для `http.createServer`.
 *
 * Порядок кроків — це і є «request flow», який на Лекції 8 обросте
 * middleware, guard'ами та interceptor'ами. Зараз він короткий:
 * розібрати URL → знайти маршрут → прочитати тіло → зібрати аргументи
 * (з валідацією всередині) → дістати контролер із контейнера → викликати →
 * серіалізувати.
 */
export function createRequestListener(container: Container, routes: Route[]): http.RequestListener {
  return (req, res) => {
    void handle(container, routes, req, res);
  };
}

async function handle(
  container: Container,
  routes: Route[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    // `req.url` — це шлях без схеми й хоста ('/users?limit=5'), тому URL
    // потрібна база. Вона фіктивна: нас цікавлять лише pathname і searchParams.
    const url = new URL(req.url ?? '/', 'http://localhost');

    const match = matchRoute(routes, req.method ?? 'GET', url.pathname);
    if (match === undefined) {
      sendJson(res, 404, { statusCode: 404, message: `Cannot ${req.method} ${url.pathname}` });
      return;
    }

    // Тіло читаємо лише там, де воно буває. На GET його немає, а зайва
    // підписка на 'data' просто ніколи б не спрацювала.
    const body = req.method === 'POST' ? await readBody(req) : undefined;

    const args = await buildArgs(match.route, { params: match.params, query: url.searchParams, body });

    // Ось тут задіяний контейнер із частини 1: екземпляр контролера не
    // створюється тут через `new`, а резолвиться з усім графом залежностей.
    // Контролер — singleton, тож на другому запиті прийде той самий обʼєкт.
    const instance = container.resolve(match.route.controller) as Record<string, unknown>;
    const handler = instance[match.route.handlerName];

    if (typeof handler !== 'function') {
      // Сюди можна потрапити лише зламавши сам фреймворк — маршрут зібрано
      // з метаданих методу, який щойно існував. Тому 500 напряму, без throw:
      // кидати виняток, щоб самому ж його зловити двома рядками нижче, —
      // зайвий гак, і IDE справедливо на нього лається.
      console.error(`[dispatcher] ${match.route.controller.name}.${match.route.handlerName} не є методом`);
      sendJson(res, 500, { statusCode: 500, message: 'Internal Server Error' });
      return;
    }

    // await навіть на синхронному результаті: хендлер може бути async,
    // і без await у відповідь пішов би серіалізований Promise ({}).
    const result: unknown = await handler.apply(instance, args);

    // 204, бо тіла немає. Віддавати 200 із 'null' — брехати клієнту,
    // що щось повернули.
    if (result === undefined) {
      res.writeHead(204).end();
      return;
    }

    // POST створює ресурс → 201, решта → 200. Так само поводиться Nest.
    sendJson(res, req.method === 'POST' ? 201 : 200, result);
  } catch (error) {
    if (error instanceof ValidationFailedError) {
      // Список ПОВНІСТЮ, а не перше поле: інакше клієнт лагодить форму
      // по одному полю за запит.
      sendJson(res, 400, { statusCode: 400, message: 'Validation failed', errors: error.errors });
      return;
    }

    if (error instanceof BadRequestError) {
      sendJson(res, 400, { statusCode: 400, message: error.message });
      return;
    }

    // Будь-що інше — це наша поломка. Текст назовні не віддаємо: у ньому
    // бувають шляхи, SQL і імена таблиць.
    console.error('[dispatcher] необроблена помилка:', error);
    if (!res.headersSent) {
      sendJson(res, 500, { statusCode: 500, message: 'Internal Server Error' });
    }
  }
}

/**
 * Складання застосунку: контролери → таблиця маршрутів → сервер.
 *
 * Сервер повертається НЕ запущеним — `listen` кличе той, хто його створив.
 * Це дрібниця, але вона робить тести можливими: вони піднімають сервер
 * на порту 0 (ядро саме дає вільний) і глушать його після себе.
 */
export function createApp(container: Container, controllers: Constructor[]): http.Server {
  const routes = collectRoutes(controllers);
  return http.createServer(createRequestListener(container, routes));
}
