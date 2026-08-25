import type { ZodType } from 'zod';

import type { FieldError } from '../errors';
import { ValidationError } from '../errors';

/**
 * Перетворює помилку Zod у наш плоский список полів.
 *
 * ⚠ `error.issues`, а НЕ `error.errors` — у Zod 4 поле перейменували.
 * Майже всі приклади в мережі написані для Zod 3 і використовують `.errors`;
 * у четвертій версії це поверне undefined, і замість осмисленої 400-ки
 * клієнт отримає порожній список полів. Мовчки.
 */
function toFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FieldError[] {
  const byField = new Map<string, string[]>();

  for (const issue of issues) {
    // path — масив сегментів: ['address', 'city'] або [] для кореня.
    // Склеюємо крапкою, щоб клієнт бачив, яке саме поле лагодити.
    const field = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');

    // Одне поле може провалити кілька правил — збираємо всі, а не перше.
    const existing = byField.get(field);
    if (existing === undefined) {
      byField.set(field, [issue.message]);
    } else {
      existing.push(issue.message);
    }
  }

  return [...byField].map(([field, constraints]) => ({ field, constraints }));
}

/**
 * Pipe: перевіряє значення схемою і віддає розібраний результат.
 *
 * Це четвертий етап циклу — він працює вже ПІСЛЯ guard'а й ПІСЛЯ входу в
 * interceptor, безпосередньо перед викликом обробника. Порядок не випадковий:
 * немає сенсу валідувати тіло запиту, який guard усе одно не пустить.
 *
 * `safeParse`, а не `parse`: `parse` кидає `ZodError`, і тоді доведеться
 * ловити чужий тип помилки. `safeParse` віддає результат прапорцем, і ми самі
 * вирішуємо, у що його перетворити.
 *
 * Zod ще й ТРАНСФОРМУЄ: `z.coerce.number()` перетворить рядок на число,
 * `.default()` підставить значення. Тому pipe повертає `result.data`, а не
 * вхідне значення — інакше вся трансформація пропала б.
 */
export function zodValidationPipe<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new ValidationError(toFieldErrors(result.error.issues));
  }

  return result.data;
}
