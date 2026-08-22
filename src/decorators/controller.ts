import 'reflect-metadata';

import { CONTROLLER_PREFIX, INJECTABLE } from '../tokens';

/**
 * Нормалізує шматок шляху: `'users'`, `'/users'`, `'users/'` → `'/users'`.
 * Порожній рядок лишається порожнім, щоб `@Controller()` + `@Get()` дали `/`.
 *
 * Робимо це ОДИН раз під час декорування, а не на кожен запит: метадані
 * пишуться при завантаженні модуля, далі їх лише читають.
 */
export function normalizePath(part: string): string {
  const trimmed = part.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `/${trimmed}`;
}

/**
 * Базовий шлях контролера.
 *
 * Робить ДВІ речі, і друга неочевидна: крім префікса ставить ще й наліпку
 * INJECTABLE. Так само поводиться справжній Nest — `@Controller()` достатньо,
 * окремий `@Injectable()` на контролер не вішають.
 *
 * Причина суто технічна. Контейнер із частини 1 відмовляється створювати клас
 * без INJECTABLE, а контролер він створювати мусить — інакше в нього не
 * інжектнеться сервіс (AC#9). Вішати два декоратори підряд можна, але тоді
 * забутий `@Injectable()` давав би помилку вже в рантаймі, на першому запиті.
 *
 * Скоуп жорстко `singleton`: контролер створюється один раз на застосунок і
 * далі обслуговує всі запити. Саме тому в ньому НЕ МОЖНА тримати стан запиту
 * в полях — це той самий міжзапитовий витік стану, що й модульна змінна.
 */
export function Controller(prefix = ''): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(CONTROLLER_PREFIX, normalizePath(prefix), target);
    Reflect.defineMetadata(INJECTABLE, 'singleton', target);
  };
}
