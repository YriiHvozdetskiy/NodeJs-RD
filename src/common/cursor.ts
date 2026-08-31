import { HttpProblem } from './http-problem';

/**
 * Keyset-пагінація.
 *
 * Offset не підтримується свідомо: при вставці рядка зверху `offset=3`
 * зсувається, і сторінка 2 повертає елемент, який уже був на сторінці 1.
 * Курсор кодує ПОЗИЦІЮ, а не номер — вставки його не рухають.
 *
 * У пару входить (created_at, id), а не тільки created_at: два рядки можуть
 * мати однакову мілісекунду, і без tie-breaker'а один із них випав би зі
 * сторінки назавжди. У даних каталогу такі рядки є навмисно (товари 4 і 5).
 */

/** Мінімум, який має рядок, щоб бути сторінкованим keyset'ом. */
export interface Keyed {
  id: number;
  created_at: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

interface CursorPosition {
  c: string;
  id: number;
}

export function encodeCursor(row: Keyed): string {
  // base64url — щоб токен був непрозорим НА ВИГЛЯД і безпечним у query-рядку.
  // Це не шифр: хто захоче — розкодує. Непрозорість тут це домовленість зі
  // спеки («клієнт не розбирає»), а не захист.
  return Buffer.from(JSON.stringify({ c: row.created_at, id: row.id })).toString('base64url');
}

export function decodeCursor(raw: string): CursorPosition {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  const pos = parsed as Partial<CursorPosition> | null;
  if (!pos || typeof pos.c !== 'string' || !Number.isInteger(pos.id)) {
    throw new HttpProblem(400, 'cursor не розпізнано — він непрозорий і належить серверу', 'invalid-cursor');
  }
  return { c: pos.c, id: pos.id as number };
}

/** Рядки відсортовані «найновіші спершу»; «після курсора» = строго СТАРІШЕ. */
function isAfterCursor(row: Keyed, pos: CursorPosition): boolean {
  if (row.created_at !== pos.c) return row.created_at < pos.c;
  return row.id < pos.id;
}

export function paginate<T extends Keyed>(rows: T[], limit: number, cursor?: string): Page<T> {
  const slice = cursor ? rows.filter((row) => isAfterCursor(row, decodeCursor(cursor))) : rows;
  const items = slice.slice(0, limit);
  const last = items.at(-1);

  // Якщо набрали рівно limit — віддаємо курсор, навіть коли далі порожньо.
  // Ціна keyset'а: дізнатись «а чи є ще» можна лише запитавши. Альтернатива —
  // тягнути limit+1 рядок і викидати останній; на #15 це робиться саме так.
  return {
    items,
    next_cursor: items.length === limit && last ? encodeCursor(last) : null,
  };
}

/** Найновіші спершу; id — tie-breaker, той самий, що всередині курсора. */
export function newestFirst(a: Keyed, b: Keyed): number {
  if (a.created_at === b.created_at) return b.id - a.id;
  return a.created_at < b.created_at ? 1 : -1;
}
