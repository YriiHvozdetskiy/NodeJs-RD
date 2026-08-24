import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError as ClassValidatorError } from 'class-validator';

import { HttpError } from '../errors';
import type { Constructor } from '../types';

/** Одне поле, що не пройшло перевірку, і всі причини — списком. */
export interface FieldError {
  field: string;
  constraints: string[];
}

/**
 * Помилка валідації тіла запиту.
 *
 * Успадковує HttpError, тож диспетчеру не треба знати про неї окремо — він
 * ловить базовий тип і бере `statusCode`. Своє в ній лише одне: список полів
 * у відповіді, заради якого й перевизначено `toResponse`.
 */
export class ValidationFailedError extends HttpError {
  constructor(public readonly errors: FieldError[]) {
    super(400, 'Validation failed');
  }

  override toResponse(): Record<string, unknown> {
    // Список ПОВНІСТЮ, а не перше поле: інакше клієнт лагодить форму
    // по одному полю за запит.
    return { statusCode: this.statusCode, message: this.message, errors: this.errors };
  }
}

/**
 * Розгортає дерево помилок class-validator у плоский список.
 *
 * Помилки приходять деревом, бо вкладений обʼєкт (`@ValidateNested()`) дає
 * свої помилки в `children`. Клієнту дерево не потрібне — йому треба знати,
 * яке поле полагодити, тож шлях склеюємо через крапку: `address.city`.
 */
function flatten(errors: ClassValidatorError[], parentPath = ''): FieldError[] {
  const result: FieldError[] = [];

  for (const error of errors) {
    const field = parentPath === '' ? error.property : `${parentPath}.${error.property}`;

    if (error.constraints !== undefined) {
      // constraints — це { isEmail: 'email must be an email', ... }.
      // Віддаємо ЗНАЧЕННЯ (людські тексти), а не ключі правил.
      result.push({ field, constraints: Object.values(error.constraints) });
    }

    if (error.children !== undefined && error.children.length > 0) {
      result.push(...flatten(error.children, field));
    }
  }

  return result;
}

/**
 * Перетворює сире тіло запиту на екземпляр DTO і перевіряє його.
 *
 * Два кроки, і порядок принциповий:
 *
 * 1. `plainToInstance` — робить із plain-обʼєкта ЕКЗЕМПЛЯР класу.
 *    Без нього `validate()` мовчки поверне порожній масив: правила лежать у
 *    MetadataStorage під конструктором, а в plain-обʼєкта конструктор — `Object`.
 *    Тобто пропустило б будь-яке сміття, і без жодної помилки.
 *    Це ж дає `body instanceof CreateUserDto` у хендлері.
 *
 * 2. `validate` з `whitelist: true` — вирізає поля, яких немає в DTO.
 *    Ріже саме на ВХОДІ: без цього чужий `{"role":"admin"}` доїхав би до
 *    сервісу і далі в базу.
 *
 * ⚠ Чого тут свідомо НЕМАЄ: приведення типів. `{"age":"30"}` дасть 400
 * `age must be an integer number`, бо рядок так рядком і лишиться.
 * Коерсія вмикається окремим прапорцем `enableImplicitConversion`, і саме
 * тому вона тут не увімкнена: мовчазне приведення типів на вході — це спосіб
 * пропустити в базу `age: "тридцять"` як щось, що «майже число».
 */
export async function validateBody<T extends object>(dto: Constructor<T>, raw: unknown): Promise<T> {
  const instance = plainToInstance(dto, raw ?? {});

  const errors = await validate(instance, {
    whitelist: true,
    // Порожнє тіло має впасти на правилах полів, а не мовчки пройти.
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new ValidationFailedError(flatten(errors));
  }

  return instance;
}
