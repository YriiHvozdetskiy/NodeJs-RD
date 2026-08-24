import 'reflect-metadata';

import { BadRequestError } from './errors';
import { CONTROLLER_PREFIX, DESIGN_PARAMTYPES, PARAMS, ROUTE } from './tokens';
import type { Constructor, ParamMap, Route, RouteMetadata } from './types';

/** Результат матчингу: сам маршрут + витягнуті зі шляху значення `:param`. */
export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

/**
 * Ріже шлях на сегменти, викидаючи порожні.
 * `'/users/42/'` → `['users', '42']`, `'/'` → `[]`.
 */
export function toSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * Усі імена методів класу, включно з успадкованими від базових контролерів.
 *
 * `Object.getOwnPropertyNames` бачить лише власний прототип, тож піднімаємось
 * ланцюгом до `Object.prototype`. `Set` прибирає дублікати: перевизначений
 * метод трапиться двічі, а маршрут у нього один.
 */
function collectHandlerNames(controller: Constructor): string[] {
  const names = new Set<string>();
  let prototype: object | null = controller.prototype;

  while (prototype !== null && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== 'constructor') {
        names.add(name);
      }
    }
    prototype = Object.getPrototypeOf(prototype);
  }

  return [...names];
}

/**
 * Збирає плоску таблицю маршрутів із метаданих переданих контролерів.
 *
 * Це і є відповідь на AC#2 «маршрути з декораторів, а не з масиву»: списку
 * шляхів у коді немає ніде, він щоразу відновлюється з того, що декоратори
 * записали при завантаженні модуля.
 *
 * Чому обхід прототипу, а не читання одного ключа з класу: `@Get`/`@Post`
 * пишуть метадані на пару `(prototype, imʼя методу)`, тож єдиний спосіб їх
 * знайти — перебрати ключі прототипу і спитати кожен.
 *
 * ⚠ Тут і лише тут — `Reflect.getMetadata`, а не `getOwnMetadata`, і це свідомо.
 * `getMetadata` піднімається ланцюгом прототипів, тож контролер-нащадок
 * успадкує маршрути базового класу — рівно як у справжньому Nest.
 * У ДЕКОРАТОРАХ навпаки, там суворо `getOwnMetadata`: вони мапу ДОПИСУЮТЬ, а
 * `getMetadata` віддав би батьківський обʼєкт за посиланням і дозапис зіпсував
 * би батька. Правило коротко: читаєш — `getMetadata`, мутуєш — `getOwnMetadata`.
 */
export function collectRoutes(controllers: Constructor[]): Route[] {
  const routes: Route[] = [];

  for (const controller of controllers) {
    const prefix: string | undefined = Reflect.getMetadata(CONTROLLER_PREFIX, controller);
    if (prefix === undefined) {
      throw new Error(
        `${controller.name} не позначений @Controller(). Без нього невідомий базовий ` +
          'шлях, і контейнер не зможе створити клас — наліпку INJECTABLE ставить теж він.',
      );
    }

    const prototype = controller.prototype as Record<string, unknown>;

    for (const handlerName of collectHandlerNames(controller)) {
      // constructor теж потрапляє в перелік, але метадані ROUTE на ньому не висять.
      const meta: RouteMetadata | undefined = Reflect.getMetadata(ROUTE, prototype, handlerName);
      if (meta === undefined) {
        continue;
      }

      const params: ParamMap = Reflect.getMetadata(PARAMS, prototype, handlerName) ?? {};

      // Ті самі design:paramtypes, що в частині 1, але для МЕТОДА. Компілятор
      // емітить їх, бо на методі висить декоратор. Звідси пайп дізнається,
      // який клас DTO створювати з тіла запиту.
      const paramTypes: Constructor[] = Reflect.getMetadata(DESIGN_PARAMTYPES, prototype, handlerName) ?? [];

      // Склейка префікса зі шляхом методу. Обидва вже нормалізовані
      // декораторами до вигляду '' або '/щось', тож конкатенації досить.
      // Порожній результат — це корінь '/'.
      const path = `${prefix}${meta.path}` || '/';

      routes.push({
        method: meta.method,
        path,
        segments: toSegments(path),
        controller,
        handlerName,
        params,
        paramTypes,
      });
    }
  }

  return routes;
}

/**
 * Зіставляє шаблон маршруту з реальним шляхом запиту.
 *
 * @param pattern Сегменти шаблону: `['users', ':id']`.
 * @param actual Сегменти запиту: `['users', '42']`.
 * @returns Мапу `{ id: '42' }`, якщо шлях підходить, або `null`, якщо ні.
 *   Порожній обʼєкт `{}` — валідний збіг без параметрів, це НЕ те саме, що `null`.
 */
export function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  // Довжина — найдешевша відсіювальна перевірка, і вона ж єдино правильна:
  // '/users' НЕ підходить під '/users/:id'. Параметр обовʼязковий, бо хендлер
  // оголосив його аргументом. Опційні сегменти в Nest теж не існують —
  // для цього оголошують другий маршрут.
  if (pattern.length !== actual.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i];

    if (expected.startsWith(':')) {
      // Розкодовуємо саме тут, а не в диспетчері: у сегменті шляху '%20' — це
      // пробіл в імені, а не роздільник. Розкодувати ДО розрізання на сегменти
      // не можна — закодований '%2F' перетворився б на зайвий '/' і зʼїхала б
      // уся структура шляху.
      //
      // try обовʼязковий: decodeURIComponent кидає URIError на будь-якому
      // битому percent-encoding ('%zz', обірваний '%E0%A4'). Без нього
      // `curl /users/%zz` клав би запит у 500 зі стектрейсом у логах —
      // тобто чуже сміття виглядало б як наша поломка. Це помилка КЛІЄНТА,
      // тож 400, і жодного стектрейсу.
      try {
        params[expected.slice(1)] = decodeURIComponent(actual[i]);
      } catch {
        throw new BadRequestError(`Сегмент шляху '${actual[i]}' містить некоректне percent-кодування`);
      }
      continue;
    }

    if (expected !== actual[i]) {
      return null;
    }
  }

  // Порожній обʼєкт — валідний збіг без параметрів (GET /users).
  // Саме тому «немає збігу» позначено null, а не порожньою мапою.
  return params;
}

/**
 * Шукає перший маршрут, який приймає цей запит.
 *
 * Порядок перебору = порядок реєстрації контролерів, і виграє ПЕРШИЙ, хто
 * підійшов. Тобто `/users/me` і `/users/:id` розрізняються лише тим, який
 * оголошено вище у класі. Так само поводиться Nest і будь-який роутер із
 * лінійним перебором — сортування за специфічністю тут ніхто не робить.
 */
export function matchRoute(routes: Route[], method: string, pathname: string): RouteMatch | undefined {
  const actual = toSegments(pathname);

  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }

    const params = matchSegments(route.segments, actual);
    if (params !== null) {
      return { route, params };
    }
  }

  return undefined;
}
