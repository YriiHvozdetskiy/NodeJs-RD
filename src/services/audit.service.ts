import { getRequestId } from '../context/request-context';
import { Injectable } from '../decorators/injectable';

/** Один запис журналу. `requestId` тут не аргумент — сервіс бере його сам. */
export interface AuditEntry {
  action: string;
  requestId: string | undefined;
  at: number;
}

/**
 * Найглибший рівень: handler → UsersService → AuditService.
 *
 * ⚠ Подивіться на сигнатуру `record` — вона приймає ЛИШЕ action. Ідентифікатор
 * запиту в аргументах не передається жодного разу, і це головне, заради чого
 * існує AsyncLocalStorage. Без нього довелося б додати зайвий аргумент у кожен
 * метод на всьому шляху від обробника сюди. Перша ж функція, яка забула його
 * прокинути, обриває трасування — а забувають завжди.
 *
 * Той самий біль ви знаєте з фронту як prop drilling. Тут він гірший: там
 * забутий пропс видно очима на екрані, тут — лише в логах, і лише коли щось
 * уже впало.
 */
@Injectable()
export class AuditService {
  private readonly entries: AuditEntry[] = [];

  record(action: string): AuditEntry {
    // Ось воно — читання зі сховища замість параметра.
    const entry: AuditEntry = { action, requestId: getRequestId(), at: Date.now() };
    this.entries.push(entry);
    return entry;
  }

  /** Останній запис — щоб тест міг перевірити, що id дійшов на цю глибину. */
  last(): AuditEntry | undefined {
    return this.entries.at(-1);
  }
}
