import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { HttpProblem, type ProblemCode } from './http-problem';

/**
 * Одна точка на ВСІ помилки — RFC 9457 problem+json.
 *
 * Механізм знайомий із L#4 (`setErrorHandler` у Fastify) і L#8 (глобальний
 * `@Catch()`); новим тут є не місце, а вміст — форму диктує стандарт.
 *
 * Ключовий факт, перевірений спайком: помилки `express-openapi-validator`
 * ДОХОДЯТЬ сюди, хоч він і звичайний Express-middleware, зареєстрований через
 * `app.use()` до роутера Nest. Тому окремий Express-level error handler не
 * потрібен: і 400 від валідації запиту, і 500 від `validateResponses` приходять
 * у цей самий фільтр.
 */

const PROBLEM_BASE = 'https://api.marketplace.example/problems';

// Назва КЛАСУ проблеми — однакова для всіх випадків цього статусу.
const TITLES: Record<number, string> = {
  400: 'Некоректний запит',
  404: 'Ресурс не знайдено',
  409: 'Конфлікт зі станом ресурсу',
  422: 'Запит неможливо опрацювати',
  500: 'Внутрішня помилка сервера',
};

const SLUGS: Record<number, ProblemCode> = {
  400: 'bad-request',
  404: 'not-found',
  409: 'conflict',
  422: 'unprocessable-entity',
  500: 'internal',
};

/** Те, що EOV кладе в `err.errors`. */
type ValidatorError = { path?: string; message?: string };

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status = this.statusOf(exception);
    const errors = this.validatorErrorsOf(exception, status);

    const body: Record<string, unknown> = {
      type: `${PROBLEM_BASE}/${this.codeOf(exception, status, errors.length > 0)}`,
      title: TITLES[status] ?? 'Помилка',
      status,
      // Текст віддаємо як є, включно з 500: саме `detail` показує дрейф коду
      // відносно спеки, і приховати його означало б осліпнути. У продакшені це
      // ховають за NODE_ENV.
      detail: this.detailOf(exception),
      instance: req.originalUrl,
    };

    // Підполя названі як у прикладі RFC 9457 §3 — pointer + detail.
    // Валідатор називає їх path + message, трансляція живе рівно тут.
    if (errors.length > 0) {
      body.errors = errors.map((e) => ({
        pointer: e.path ?? '/',
        detail: e.message ?? 'не пройшло перевірку',
      }));
    }

    res.status(status).type('application/problem+json').json(body);
  }

  private statusOf(exception: unknown): number {
    if (exception instanceof HttpProblem) return exception.status;
    if (exception instanceof HttpException) return exception.getStatus();
    const raw = Number((exception as { status?: unknown })?.status);
    return raw >= 400 && raw <= 599 ? raw : 500;
  }

  /**
   * Масив подробиць беремо ТІЛЬКИ для 400. Свій `err.errors` валідатор чіпляє
   * і до 404 «такого шляху немає у спеці», а це не помилка валідації — там
   * `pointer` вказував би на URL замість місця в тілі запиту.
   */
  private validatorErrorsOf(exception: unknown, status: number): ValidatorError[] {
    if (status !== 400) return [];
    const errors = (exception as { errors?: unknown })?.errors;
    return Array.isArray(errors) ? (errors as ValidatorError[]) : [];
  }

  private codeOf(exception: unknown, status: number, fromValidator: boolean): ProblemCode {
    if (exception instanceof HttpProblem && exception.code) return exception.code;
    if (fromValidator) return 'validation-error';
    return SLUGS[status] ?? 'internal';
  }

  private detailOf(exception: unknown): string {
    if (exception instanceof HttpProblem) return exception.detail;
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'string') return response;
      const message = (response as { message?: unknown })?.message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.join(', ');
    }
    const message = (exception as { message?: unknown })?.message;
    return typeof message === 'string' ? message : 'Сталося щось непередбачене';
  }
}
