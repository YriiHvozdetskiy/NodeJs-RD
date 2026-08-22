import 'reflect-metadata';

import { ROUTE } from '../tokens';
import type { HttpMethod } from '../types';
import { normalizePath } from './controller';

/**
 * Фабрика декораторів маршруту. `@Get` і `@Post` відрізняються рівно одним
 * рядком — HTTP-методом, тож писати їх двічі немає сенсу.
 *
 * ⚠ Ключова відмінність від декораторів частини 1: метадані пишемо на ПАРУ
 * `(prototype, imʼя методу)`, а не на клас. У `Reflect` це третій і четвертий
 * аргументи `defineMetadata`. Наслідок для роутера: маршрути не лежать
 * купкою в одному місці — щоб їх знайти, треба обійти прототип класу
 * і спитати кожен його ключ окремо.
 *
 * `target` тут — саме `Ctor.prototype`, а не `Ctor`: декоратор методу
 * екземпляра отримує прототип. (Для `static` методу отримав би сам клас —
 * ще одна причина, чому роутер дивиться саме в `prototype`.)
 */
function createRouteDecorator(method: HttpMethod) {
  return (path = ''): MethodDecorator =>
    (target, propertyKey) => {
      Reflect.defineMetadata(ROUTE, { method, path: normalizePath(path) }, target, propertyKey);
    };
}

/** `@Get()` → `GET /prefix`; `@Get(':id')` → `GET /prefix/:id`. */
export const Get = createRouteDecorator('GET');

/** `@Post()` → `POST /prefix`. */
export const Post = createRouteDecorator('POST');
