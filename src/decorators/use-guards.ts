import 'reflect-metadata';

import { GUARDS, INTERCEPTORS } from '../tokens';
import type { Constructor } from '../types';

/**
 * Фабрика для @UseGuards / @UseInterceptors — вони відрізняються лише ключем.
 *
 * Декоратор навмисно працює І на класі, І на методі. Різницю дає `propertyKey`:
 * для класу він `undefined` (і тоді `target` — сам клас), для методу — імʼя
 * (а `target` — прототип). Це той самий прийом, яким @Inject відрізняє
 * параметр конструктора від параметра методу.
 *
 * Навіщо два рівні: `@UseGuards(AuthGuard)` на класі захищає весь контролер,
 * на методі — один маршрут. Без цього довелось би або вішати guard глобально
 * (і тоді ЖОДЕН маршрут не працює без Authorization), або дублювати його на
 * кожному методі.
 */
function createUseDecorator(key: symbol) {
  return (...targets: Constructor[]) =>
    (target: object, propertyKey?: string | symbol): void => {
      if (propertyKey === undefined) {
        Reflect.defineMetadata(key, targets, target);
        return;
      }
      Reflect.defineMetadata(key, targets, target, propertyKey);
    };
}

/**
 * `@UseGuards(AuthGuard)` — на класі або на методі.
 *
 * Це і є те, що в справжньому Nest пишеться так само: масив класів, які
 * контейнер створить і в яких спитає `canActivate` перед обробником.
 */
export const UseGuards = createUseDecorator(GUARDS);

/** `@UseInterceptors(LoggingInterceptor)` — на класі або на методі. */
export const UseInterceptors = createUseDecorator(INTERCEPTORS);
