import { getRequestId } from '../context/request-context';
import { Injectable } from '../decorators/injectable';
import type { Interceptor, LifecycleContext } from '../types';

/**
 * Куди пишемо. Винесено в змінну, щоб тест міг підмінити його й перевірити
 * формат рядка, не перехоплюючи глобальний console.
 */
export type LogSink = (line: string) => void;

let sink: LogSink = (line) => {
  console.log(line);
};

/** Підміна виводу — для тестів. Повертає функцію, що вертає все як було. */
export function setLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

/**
 * Міряє, скільки тривала обробка, і пише рядок у лог.
 *
 * ОСЬ ЧОМУ INTERCEPTOR — НЕ ФАЗА. Guard, pipe і handler — це точки на лінії:
 * викликались і минули. Interceptor обгортає все, що після нього: код до
 * `next()` бачить вхід, код після — вихід. Заміряти тривалість фазою було б
 * неможливо — довелося б робити два окремі хуки й самому стежити, щоб між
 * ними ніхто не вклинився.
 *
 * `finally` обовʼязковий: якщо обробник кинув помилку, тривалість усе одно
 * треба записати. Саме повільні падіння цікавлять найбільше, а без `finally`
 * вони б у лог не потрапили взагалі.
 *
 * `performance.now()`, а не `Date.now()`: другий має роздільність у цілу
 * мілісекунду і може стрибнути назад, якщо системний час підкрутить NTP.
 */
@Injectable()
export class LoggingInterceptor implements Interceptor {
  async intercept(ctx: LifecycleContext, next: () => Promise<void>): Promise<void> {
    const startedAt = performance.now();

    try {
      await next();
    } finally {
      const ms = (performance.now() - startedAt).toFixed(1);

      // requestId беремо зі сховища, а не з аргументів: interceptor працює
      // всередині als.run(), тож id доступний просто так.
      const requestId = getRequestId();
      const prefix = requestId === undefined ? '' : `[${requestId}] `;

      sink(`${prefix}${ctx.method} ${ctx.path} — ${ms} ms`);
    }
  }
}
