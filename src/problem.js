'use strict';

// Єдина точка, де будь-яка помилка перетворюється на RFC 9457 problem+json.
// Механізм той самий, що на L#4 (`setErrorHandler` Fastify) і L#8 (глобальний
// `@Catch()` у Nest) — новим є лише ВМІСТ: форму диктує RFC, а не автор.

const PROBLEM_BASE = 'https://api.marketplace.example/problems';

// `title` — назва КЛАСУ проблеми: однакова для всіх 404. Конкретика — в `detail`.
const TITLES = {
  400: 'Некоректний запит',
  404: 'Ресурс не знайдено',
  409: 'Конфлікт зі станом ресурсу',
  422: 'Запит неможливо опрацювати',
  500: 'Внутрішня помилка сервера',
};

// `type` — стабільний URI, по якому клієнт матчить помилку. Саме тому це слаг,
// а не число: 'unknown-product' і 'idempotency-key-reused' обидва дають 422,
// але клієнт має реагувати на них по-різному.
const SLUGS = {
  400: 'bad-request',
  404: 'not-found',
  409: 'conflict',
  422: 'unprocessable-entity',
  500: 'internal',
};

class HttpProblem extends Error {
  constructor(status, detail, { code } = {}) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
}

function toProblem(err, req) {
  const raw = Number(err.status ?? err.statusCode);
  const status = raw >= 400 && raw <= 599 ? raw : 500;

  // express-openapi-validator віддає масив err.errors — це і є та сама
  // валідація, тільки суддя стоїть на кордоні процесу, а не всередині.
  // Тільки для 400: свій err.errors валідатор чіпляє і до 404 «шляху немає у
  // спеці», а це не помилка валідації — там `pointer` вказував би на URL.
  const fromValidator = status === 400 && Array.isArray(err.errors) && err.errors.length > 0;

  const problem = {
    type: `${PROBLEM_BASE}/${err.code ?? (fromValidator ? 'validation-error' : SLUGS[status])}`,
    title: TITLES[status] ?? 'Помилка',
    status,
    // Текст помилки віддаємо як є — включно з 500. У продакшені це ховають за
    // NODE_ENV, але тут саме `detail` показує дрейф коду відносно спеки, і
    // приховати його означало б осліпнути.
    detail: String(err.detail ?? err.message ?? 'Сталося щось непередбачене'),
    instance: req.originalUrl,
  };

  if (fromValidator) {
    // Підполя названі як у прикладі RFC 9457 §3: pointer + detail.
    // Валідатор називає їх path + message — трансляція живе рівно тут.
    problem.errors = err.errors.map((e) => ({
      pointer: e.path ?? '/',
      detail: e.message ?? 'не пройшло перевірку',
    }));
  }

  return problem;
}

module.exports = { HttpProblem, toProblem };
