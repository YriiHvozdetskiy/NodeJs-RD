import type { ForwardRef, MaybeForwardRef, Token } from './types';

/**
 * Загортає токен у тунк, щоб відкласти його обчислення до моменту резолву.
 *
 * ```ts
 * @Injectable() class A { constructor(@Inject(forwardRef(() => B)) b: IB) {} }
 * @Injectable() class B { constructor(a: A) {} }   // A вже оголошено — можна за типом
 * ```
 *
 * Без цього перший клас впаде на завантаженні модуля, бо `B` у момент
 * емісії метаданих ще в TDZ.
 */
export function forwardRef<T>(fn: () => Token<T>): ForwardRef<T> {
  return { forwardRef: fn };
}

/**
 * Розрізняє тунк і звичайний токен.
 *
 * Перевіряємо не лише наявність поля, а й що воно викликається: під
 * рядковим токеном 'forwardRef' або класом із такою властивістю інакше
 * можна було б випадково збігтися.
 */
export function isForwardRef(value: unknown): value is ForwardRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'forwardRef' in value &&
    typeof value.forwardRef === 'function'
  );
}

/** Розгортає тунк, якщо він є; звичайний токен віддає як є. */
export function unwrapToken<T>(value: MaybeForwardRef<T>): Token<T> {
  return isForwardRef(value) ? value.forwardRef() : value;
}
