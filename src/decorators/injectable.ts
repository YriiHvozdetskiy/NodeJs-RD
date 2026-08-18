import 'reflect-metadata';

import { INJECTABLE } from '../tokens';
import type { InjectableOptions } from '../types';

/**
 * Позначає клас як придатний до створення контейнером.
 *
 * Це decorator factory: `@Injectable()` — це ВИКЛИК, який повертає власне
 * декоратор. Тому дужки обовʼязкові навіть без аргументів.
 *
 * Важливо, чого тут НЕ буде: читання типів конструктора. Їх уже поклав
 * компілятор під ключем 'design:paramtypes' — рівно тому, що побачив на класі
 * хоч один декоратор. Робота цієї функції — лише поставити наліпку, за якою
 * контейнер відрізнить «свій» клас від чужого, і запамʼятати скоуп.
 *
 * @param options `{ scope: 'transient' }` — новий екземпляр на кожен resolve.
 *   Без аргументів скоуп має бути 'singleton'.
 */
export function Injectable(options: InjectableOptions = {}): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(INJECTABLE, options.scope ?? 'singleton', target);
  };
}
