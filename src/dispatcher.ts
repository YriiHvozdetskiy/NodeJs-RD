import 'reflect-metadata';

import * as http from 'node:http';

import type { Container } from './container';
import { BadRequestError, HttpError, NotFoundError } from './errors';
import { parseScalar } from './pipes/parse.pipe';
import { validateBody } from './pipes/validation.pipe';
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

/**
 * Усе, що стадії знають про поточний запит, і все, що вони одна одній передають.
 *
 * Мутабельний навмисно: кожна стадія дописує своє поле (`body` → `args` →
 * `result`), наступна його бачить. Це той самий контракт, що в `ExecutionContext`
 * у Nest — саме через нього на Лекції 8 guard'и й interceptor'и отримають
 * доступ до запиту, не чіпаючи сигнатуру хендлера.
 */
export interface ExecutionContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly route: Route;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  body: unknown;
  args: unknown[];
  result: unknown;
}

/**
 * Одна стадія обробки запиту.
 *
 * Сигнатура `(ctx, next)` — не випадкова: це рівно контракт Redux middleware
 * і koa. Він дає те, чого не дає плоский список кроків: стадія бачить момент
 * ДО `next()` і момент ПІСЛЯ. Без цього interceptor з Лекції 8 (який має
 * заміряти час навколо хендлера або підмінити відповідь) написати неможливо —
 * довелось би різати його на дві окремі стадії й самому стежити за порядком.
 */
export type Stage = (ctx: ExecutionContext, next: () => Promise<void>) => Promise<void>;

/**
 * Склеює стадії в один ланцюг.
 *
 * `index` стереже подвійний виклик `next()`: без цієї перевірки стадія, що
 * випадково викликала `next()` двічі, тихо виконала б увесь хвіст ланцюга
 * повторно — хендлер відпрацював би два рази на один запит.
 */
export function compose(stages: Stage[]): (ctx: ExecutionContext) => Promise<void> {
  return (ctx) => {
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        throw new Error('next() викликано двічі в одній стадії');
      }
      index = i;

      const stage = stages[i];
      if (stage === undefined) {
        return;
      }

      await stage(ctx, () => dispatch(i + 1));
    };

    return dispatch(0);
  };
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

// ── Стадії ─────────────────────────────────────────────────────────────────

/**
 * Тіло читаємо лише там, де воно буває. На GET його немає, а зайва
 * підписка на 'data' просто ніколи б не спрацювала.
 */
const bodyStage: Stage = async (ctx, next) => {
  if (ctx.req.method === 'POST') {
    ctx.body = await readBody(ctx.req);
  }
  await next();
};

/**
 * Будує масив аргументів хендлера за мапою параметр-декораторів.
 *
 * Ітеруємо по ІНДЕКСАХ, а не по мапі: мапа розріджена, і якщо будувати список
 * із її ключів, аргумент без декоратора просто зникне, а всі наступні зʼїдуть
 * на позицію вліво. Кількість аргументів задає `design:paramtypes`.
 *
 * Стадія асинхронна — і це головна відмінність від `resolve` з частини 1.
 * Там граф збирався синхронно, бо всі залежності вже були в памʼяті. Тут
 * посередині стоїть валідація DTO, а вона повертає проміс.
 *
 * Пайп викликається для КОЖНОГО джерела, не лише для тіла: `@Query('limit')
 * limit: number` має прийти числом, інакше приведення тікає в хендлер, а
 * помилка «limit=abc» вилазить десь глибше замість межі запиту.
 */
const argsStage: Stage = async (ctx, next) => {
  const { route } = ctx;
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

    const declared = route.paramTypes[index];

    switch (meta.source) {
      case 'param':
        args[index] =
          meta.name === undefined
            ? ctx.params
            : parseScalar(ctx.params[meta.name], declared, `Параметр шляху '${meta.name}'`);
        break;

      case 'query':
        // `?? undefined` навмисно: URLSearchParams.get віддає null, а
        // дефолтне значення аргументу (`limit = 10`) спрацьовує лише на undefined.
        args[index] =
          meta.name === undefined
            ? ctx.query
            : parseScalar(ctx.query.get(meta.name) ?? undefined, declared, `Query-параметр '${meta.name}'`);
        break;

      case 'body':
        // Пайп вмикається САМ, якщо тип аргументу — клас DTO. Це те, що в Nest
        // робить глобальний ValidationPipe: окремо його тут вішати не треба.
        args[index] = isDtoClass(declared) ? await validateBody(declared, ctx.body) : ctx.body;
        break;
    }
  }

  ctx.args = args;
  await next();
};

/**
 * Дістає контролер із контейнера і викликає хендлер.
 *
 * Остання стадія ланцюга: `next()` не кличе, бо далі нічого немає.
 * На Лекції 8 усе, що обгортає виклик (interceptor'и), стане стадіями ПЕРЕД
 * нею, а guard'и — ще раніше, до `argsStage`.
 */
function createHandlerStage(container: Container): Stage {
  return async (ctx) => {
    // Ось тут задіяний контейнер із частини 1: екземпляр контролера не
    // створюється через `new`, а резолвиться з усім графом залежностей.
    // Контролер — singleton, тож на другому запиті прийде той самий обʼєкт.
    const instance = container.resolve(ctx.route.controller) as Record<string, unknown>;
    const handler = instance[ctx.route.handlerName];

    if (typeof handler !== 'function') {
      throw new Error(`${ctx.route.controller.name}.${ctx.route.handlerName} не є методом`);
    }

    // await навіть на синхронному результаті: хендлер може бути async,
    // і без await у відповідь пішов би серіалізований Promise ({}).
    ctx.result = await handler.apply(instance, ctx.args);
  };
}

// ── Транспорт ──────────────────────────────────────────────────────────────

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
 * Ланцюг стадій будується ОДИН раз, на старті, а не на кожен запит: склеювати
 * замикання 10 000 разів на секунду немає жодного сенсу — контекст усе одно
 * свій у кожного запиту.
 */
export function createRequestListener(container: Container, routes: Route[]): http.RequestListener {
  const pipeline = compose([bodyStage, argsStage, createHandlerStage(container)]);

  return (req, res) => {
    void handle(routes, pipeline, req, res);
  };
}

/**
 * Успішний шлях: знайти маршрут, прогнати ланцюг, відповісти.
 *
 * Винесено з `handle` навмисно. Кидати помилку, щоб самому ж її зловити
 * двома рядками нижче, — гак, який до того ж заважає читати: незрозуміло,
 * чи це «наш» throw, чи чужий. Тепер розподіл однозначний: тут — що робимо,
 * у `handle` — що робимо, коли не вийшло.
 */
async function execute(
  routes: Route[],
  pipeline: (ctx: ExecutionContext) => Promise<void>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // `req.url` — це шлях без схеми й хоста ('/users?limit=5'), тому URL
  // потрібна база. Вона фіктивна: нас цікавлять лише pathname і searchParams.
  const url = new URL(req.url ?? '/', 'http://localhost');

  const match = matchRoute(routes, req.method ?? 'GET', url.pathname);
  if (match === undefined) {
    throw new NotFoundError(`Cannot ${req.method} ${url.pathname}`);
  }

  const ctx: ExecutionContext = {
    req,
    res,
    route: match.route,
    params: match.params,
    query: url.searchParams,
    body: undefined,
    args: [],
    result: undefined,
  };

  await pipeline(ctx);

  // 204, бо тіла немає. Віддавати 200 із 'null' — брехати клієнту,
  // що щось повернули.
  if (ctx.result === undefined) {
    res.writeHead(204).end();
    return;
  }

  // POST створює ресурс → 201, решта → 200. Так само поводиться Nest.
  sendJson(res, req.method === 'POST' ? 201 : 200, ctx.result);
}

/**
 * Межа, за яку жодна помилка не проходить.
 *
 * Це єдине місце у всьому шарі, де вирішується, що клієнт побачить після
 * збою. На Лекції 8 сюди стане exception filter.
 */
async function handle(
  routes: Route[],
  pipeline: (ctx: ExecutionContext) => Promise<void>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    await execute(routes, pipeline, req, res);
  } catch (error) {
    // Одна гілка на всі очікувані помилки: кожна знає свій статус і своє тіло.
    if (error instanceof HttpError) {
      sendJson(res, error.statusCode, error.toResponse());
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
