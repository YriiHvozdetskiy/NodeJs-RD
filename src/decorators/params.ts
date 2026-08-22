import 'reflect-metadata';

import { PARAMS } from '../tokens';
import type { ParamMap, ParamSource } from '../types';

/**
 * Фабрика параметр-декораторів.
 *
 * Головна ідея ДЗ, і вона контрінтуїтивна: `@Param('id')` НЕ дістає `id`.
 * У момент, коли він виконується, запиту ще не існує — модуль щойно
 * завантажився, сервер навіть не слухає порт. Усе, що робить декоратор, —
 * лишає записку «аргумент №0 треба взяти з params під іменем id».
 * Дістає значення диспетчер, під час виклику, коли запит уже є.
 *
 * Єдиний ключ, який переживає компіляцію, — ІНДЕКС параметра. Імена
 * аргументів у метадані не потрапляють, а типи в обох випадках будуть `String`
 * і розрізнити за ними позиції неможливо. Звідси розріджена мапа за індексом —
 * той самий прийом, що в `@Inject` із частини 1.
 */
function createParamDecorator(source: ParamSource) {
  return (name?: string): ParameterDecorator =>
    (target, propertyKey, parameterIndex) => {
      // Параметр КОНСТРУКТОРА дає propertyKey === undefined — так відрізняється
      // @Inject від @Body. Тут конструктор не підходить: тіло запиту в нього
      // передати нікуди, контролер створюється один раз на застосунок.
      if (propertyKey === undefined) {
        throw new Error(
          `@${source[0].toUpperCase()}${source.slice(1)}() стоїть на параметрі конструктора. ` +
            'Ці декоратори працюють лише на параметрах методів-хендлерів: ' +
            'значення беруться з конкретного запиту, а конструктор виконується один раз.',
        );
      }

      // getOwnMetadata, а не getMetadata — з тієї ж причини, що в @Inject:
      // getMetadata пішов би по ланцюгу прототипів і віддав мапу однойменного
      // методу БАТЬКІВСЬКОГО контролера за посиланням, а дозапис нижче
      // мутував би її на місці.
      const map: ParamMap = Reflect.getOwnMetadata(PARAMS, target, propertyKey) ?? {};

      // Дозапис, а не заміна: параметр-декоратори спрацьовують по одному,
      // у зворотному порядку індексів (n-1 → 0).
      map[parameterIndex] = { source, name };

      Reflect.defineMetadata(PARAMS, map, target, propertyKey);
    };
}

/** `@Body() dto: CreateUserDto` — усе розпарсене тіло запиту. */
export const Body: () => ParameterDecorator = createParamDecorator('body');

/** `@Param('id') id: string` — сегмент шляху зі шаблону `/users/:id`. */
export const Param: (name: string) => ParameterDecorator = createParamDecorator('param');

/** `@Query('limit') limit: string` — значення з query string. */
export const Query: (name: string) => ParameterDecorator = createParamDecorator('query');
