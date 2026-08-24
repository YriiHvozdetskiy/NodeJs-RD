'use strict';

const { HttpProblem } = require('./problem');

// Keyset-пагінація. Offset тут не підтримується свідомо: при вставці нового
// рядка зверху `offset=3` зсувається, і сторінка 2 повертає елемент, який уже
// був на сторінці 1. Курсор кодує ПОЗИЦІЮ, а не номер — вставки його не рухають.
//
// У пару входить (created_at, id), а не тільки created_at: два рядки можуть
// мати однакову мілісекунду, і без tie-breaker'а один із них випав би зі
// сторінки назавжди. У даних нижче такі рядки є навмисно (products 4 і 5).

function encodeCursor(row) {
  // base64url — щоб токен був непрозорим НА ВИГЛЯД і безпечним у query-рядку.
  // Це не шифр: хто захоче — розкодує. Непрозорість тут — домовленість зі
  // спеки («клієнт не розбирає»), а не захист.
  return Buffer.from(JSON.stringify({ c: row.created_at, id: row.id })).toString('base64url');
}

function decodeCursor(raw) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed.c !== 'string' || !Number.isInteger(parsed.id)) {
    throw new HttpProblem(400, 'cursor не розпізнано — він непрозорий і належить серверу', {
      code: 'invalid-cursor',
    });
  }
  return parsed;
}

// Рядки приходять відсортовані «найновіші спершу»: (created_at DESC, id DESC).
// «Після курсора» = строго СТАРІШЕ за нього.
function isAfterCursor(row, pos) {
  if (row.created_at !== pos.c) return row.created_at < pos.c;
  return row.id < pos.id;
}

function paginate(rows, { limit, cursor }) {
  const slice = cursor ? rows.filter((row) => isAfterCursor(row, decodeCursor(cursor))) : rows;
  const items = slice.slice(0, limit);
  const last = items[items.length - 1];

  // Якщо набрали рівно limit — віддаємо курсор, навіть коли далі порожньо.
  // Ціна keyset'а: дізнатись «а чи є ще» можна лише запитавши. Альтернатива —
  // тягнути limit+1 рядок і викидати останній; на #15 це робиться саме так.
  return {
    items,
    next_cursor: items.length === limit && last ? encodeCursor(last) : null,
  };
}

module.exports = { encodeCursor, decodeCursor, paginate };
