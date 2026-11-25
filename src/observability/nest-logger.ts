import type { LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';
import { logger } from './logger';

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Nest пише в лог сам — старт модулів, маршрути, `new Logger('Redis')` у
 * сервісах — і за замовчуванням робить це кольоровим текстом, а не JSON.
 * Цей адаптер передається в `NestFactory.create({ logger })`, і тоді кожен
 * такий рядок іде через pino: той самий формат, той самий mixin із trace_id.
 *
 * Контекст Nest (`RoutesResolver`, `Redis`) стає полем `layer`, як у шарів.
 */
export class PinoNestLogger implements LoggerService {
  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  /**
   * Nest кличе `log(message, context)` і `error(message, stack, context)`:
   * останній рядковий аргумент — контекст, решта — подробиці (стек).
   */
  private write(level: Level, message: unknown, rest: unknown[]): void {
    const args = [...rest];
    const context = args.length > 0 && typeof args[args.length - 1] === 'string' ? String(args.pop()) : undefined;
    const target: Logger = logger.child({ layer: context ? `nest.${context}` : 'nest' });
    const stack = args.find((arg): arg is string => typeof arg === 'string');

    if (message instanceof Error) {
      target[level]({ err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      target[level](message);
    } else {
      target[level](stack ? { stack } : {}, String(message));
    }
  }
}
