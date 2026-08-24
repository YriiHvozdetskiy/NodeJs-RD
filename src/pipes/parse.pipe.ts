import { BadRequestError } from '../errors';

/**
 * Приведення скалярного аргументу до оголошеного типу.
 *
 * Навіщо: `@Query('limit') limit: number` без цього кроку віддає РЯДОК '5',
 * і хендлер змушений робити `parseInt` руками. Це не косметика — приведення
 * у тілі хендлера означає, що бізнес-логіка займається транспортом, і що
 * помилка «limit=abc» вилізе десь глибше, а не на межі.
 *
 * URL типів не має взагалі: і `?limit=5`, і `/users/42` — це рядки. Єдине
 * джерело правди про очікуваний тип — `design:paramtypes` хендлера, той самий
 * ключ, яким контейнер резолвить конструктор.
 *
 * Це рівно те, що в Nest роблять `ParseIntPipe` / `ParseBoolPipe`, або
 * глобальний ValidationPipe з `transform: true`.
 */
export function parseScalar(value: string | undefined, declared: unknown, label: string): unknown {
  // Відсутнє значення лишається undefined, а не перетворюється на 0 чи ''.
  // Інакше дефолт аргументу (`limit = 10`) ніколи б не спрацював.
  if (value === undefined) {
    return undefined;
  }

  if (declared === Number) {
    // Number(), а не parseInt: parseInt('12abc') мовчки дає 12, і опечатка
    // в query перетворюється на валідне, але не те число.
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new BadRequestError(`${label} має бути числом, отримано '${value}'`);
    }
    return parsed;
  }

  if (declared === Boolean) {
    // Порожній прапорець у URL ('?debug') прийде як '' і означає «увімкнено» —
    // так поводиться більшість API, і це єдиний випадок, де '' не є хибою.
    if (value === '' || value === 'true' || value === '1') {
      return true;
    }
    if (value === 'false' || value === '0') {
      return false;
    }
    throw new BadRequestError(`${label} має бути true або false, отримано '${value}'`);
  }

  // String або тип, якого ми не знаємо — віддаємо як є.
  return value;
}
