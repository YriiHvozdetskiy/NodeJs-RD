import { HttpProblem } from './http-problem';

/**
 * Keyset-пагінація.
 *
 * Offset не підтримується свідомо: при вставці рядка зверху `offset=3`
 * зсувається, і сторінка 2 повертає елемент, який уже був на сторінці 1.
 * Курсор кодує ПОЗИЦІЮ, а не номер — вставки його не рухають.
 *
 * У пару входить (created_at, id), а не тільки created_at: два рядки можуть
 * мати однаковий час, і без tie-breaker'а один із них випав би зі сторінки
 * назавжди. У Postgres це не рідкість, а норма: `now()` — час початку
 * транзакції, тож усі рядки одного INSERT-а чи одного сіду мають той самий
 * created_at до мікросекунди.
 *
 * І саме мікросекунди — пастка, якої не було, поки дані жили в памʼяті.
 * `timestamptz` зберігає 6 знаків після секунди, JS `Date` — 3. Курсор із
 * мілісекундами округлює позицію ВНИЗ, і рядки, що лежать у тій самій
 * мілісекунді, але старші за останній показаний, пропадають зі сторінки. Тому
 * позицію віддає сама база текстом (`cursorAt`), а не `Date` з драйвера.
 */

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

interface CursorPosition {
  /** created_at з мікросекундами, UTC: `2026-09-30T10:00:00.000123Z`. */
  c: string;
  id: number;
}

/** Рядок, який уміє стати курсором: id з драйвера (bigint — рядком) і позиція від `cursorAt`. */
export interface KeysetRow {
  id: string;
  cursor_at: string;
}

const CURSOR_AT_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** SQL-вираз: `timestamptz` як текст у тому форматі, що лежить у курсорі. */
export function cursorAt(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function encodeCursor(position: CursorPosition): string {
  // base64url — щоб токен був непрозорим НА ВИГЛЯД і безпечним у query-рядку.
  // Це не шифр: хто захоче — розкодує. Непрозорість тут це домовленість зі
  // спеки («клієнт не розбирає»), а не захист.
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

/**
 * Усе, що не схоже на курсор, виданий цим сервером, — 400 `invalid-cursor`, а
 * не 500. Позиція далі йде в SQL параметром: непарсибельна дата чи id поза
 * bigint там стали б помилкою Postgres, а не помилкою клієнта.
 */
export function decodeCursor(raw: string): CursorPosition {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  const c: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'c') : undefined;
  const id: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'id') : undefined;
  if (
    typeof c !== 'string' ||
    !CURSOR_AT_FORMAT.test(c) ||
    Number.isNaN(Date.parse(c)) ||
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id < 1
  ) {
    throw new HttpProblem(400, 'cursor не розпізнано — він непрозорий і належить серверу', 'invalid-cursor');
  }
  return { c, id };
}

/**
 * Репозиторій просить у бази `limit + 1` рядок: зайвий не показується, він
 * лише відповідає на «а чи є ще». Тому на останній сторінці `next_cursor`
 * чесно `null`, а не курсор на порожню сторінку.
 */
export function toPage<R extends KeysetRow, T>(rows: R[], limit: number, map: (row: R) => T): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(map),
    next_cursor: rows.length > limit && last ? encodeCursor({ c: last.cursor_at, id: Number(last.id) }) : null,
  };
}
