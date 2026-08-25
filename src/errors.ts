/**
 * Помилки, які диспетчер уміє перетворити на HTTP-відповідь.
 *
 * Навіщо окрема ієрархія замість голого Error: диспетчер має відрізнити
 * «клієнт надіслав дурню» від «ми зламались». Без цієї межі будь-яка
 * поломка сервера виглядала б для клієнта як його власна помилка — або
 * навпаки, битий ввід писав би нам у логи стектрейс і 500.
 *
 * На Лекції 8 сюди прийдуть exception filters, і саме `statusCode` буде тим,
 * на що вони дивляться.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }

  /** Тіло відповіді. Підкласи додають свої поля, перевизначивши це. */
  toResponse(): Record<string, unknown> {
    return { statusCode: this.statusCode, message: this.message };
  }
}

/** 400 — запит неможливо обробити через те, що в ньому надіслали. */
export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

/** 404 — такого маршруту немає. */
export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, message);
  }
}

/** Одне поле, що не пройшло перевірку, і всі причини — списком. */
export interface FieldError {
  field: string;
  constraints: string[];
}

/**
 * 400 — тіло не відповідає контракту.
 *
 * Своє в ній лише одне: список полів у відповіді, заради якого й перевизначено
 * `toResponse`. Клієнт має побачити ВСІ проблеми одразу, інакше лагодить форму
 * по одному полю за запит.
 */
export class ValidationError extends HttpError {
  constructor(public readonly errors: FieldError[]) {
    super(400, 'Validation failed');
  }

  override toResponse(): Record<string, unknown> {
    return { statusCode: this.statusCode, message: this.message, errors: this.errors };
  }
}

/** 403 — guard не пустив. Не 401: тут не про «хто ви», а про «вам сюди не можна». */
export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message);
  }
}
