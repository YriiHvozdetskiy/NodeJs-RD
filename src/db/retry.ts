import { setTimeout as sleep } from 'node:timers/promises';
import { pgErrorField } from './sql';

/**
 * Лише дві помилки означають «база сама вбила транзакцію через конкуренцію, і
 * той самий код, запущений ще раз з нуля, має шанс пройти»:
 *
 *   40001 serialization_failure — під REPEATABLE READ / SERIALIZABLE рядок,
 *         який ми читали, змінила й закомітила інша транзакція;
 *   40P01 deadlock_detected    — дві транзакції чекали одна на одну, Postgres
 *         обрав жертву й відкотив її.
 *
 * Усе інше повторювати не можна або марно:
 *   • 23505 / 23514 / 23503 (unique, check, FK) — детерміновані: той самий
 *     запит на тих самих даних впаде знову, повтор лише множить навантаження;
 *   • обрив з'єднання (08xxx, ECONNRESET) — якщо він стався після того, як
 *     COMMIT уже пішов у сокет, ми не знаємо, чи транзакція закомітилась.
 *     Повтор тут = подвійне замовлення. Це задача ідемпотентності (#9, #22),
 *     а не retry;
 *   • помилки бізнес-логіки (CheckoutError) — «товару нема» не з'явиться від
 *     того, що ми спитаємо вдруге.
 */
const RETRYABLE: ReadonlySet<string> = new Set(['40001', '40P01']);

export interface RetryEvent {
  label: string;
  code: string;
  /** Номер спроби, що щойно впала (1 — перша). */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

export interface RetryOptions {
  label?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (event: RetryEvent) => void;
}

const logRetry = (e: RetryEvent) =>
  console.warn(`[retry] ${e.label}: ${e.code}, спроба ${e.attempt}/${e.maxAttempts} — повтор усієї транзакції через ${e.delayMs} мс`);

/**
 * Повторює `run` цілком — разом із BEGIN і всіма читаннями.
 *
 * `run` мусить сам відкривати транзакцію (`dataSource.transaction(...)`):
 * повторити лише UPDATE з уже прочитаним значенням — це той самий lost update,
 * тільки з логом. Читання мають бути зроблені наново, на свіжому снапшоті.
 *
 * Backoff експоненційний із full jitter: пауза випадкова в [0, base·2^n].
 * Без випадковості транзакції, що зіткнулися, прокидаються одночасно й
 * стикаються знову — той самий шквал, тільки зсунутий у часі.
 */
export async function withRetry<T>(run: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { label = 'tx', maxAttempts = 8, baseDelayMs = 10, maxDelayMs = 500, onRetry = logRetry } = options;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      const code = pgErrorField(err, 'code');
      if (code === undefined || !RETRYABLE.has(code) || attempt >= maxAttempts) throw err;

      const delayMs = Math.floor(Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
      onRetry({ label, code, attempt, maxAttempts, delayMs });
      await sleep(delayMs);
    }
  }
}
