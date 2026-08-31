import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';

export type Verdict = 'proceed' | 'replay' | 'in-flight' | 'mismatch';

interface Entry<T> {
  state: 'in-flight' | 'done';
  fingerprint: string;
  response?: T;
  expiresAt: number;
}

/**
 * Сховище ключів ідемпотентності.
 *
 * У памʼяті — і це чесно названа межа: після рестарту процесу той самий ключ
 * створить замовлення ВДРУГЕ. Спільне сховище (Redis `SET NX EX 86400`)
 * приїде на #23; провайдером воно вже зараз, тож заміна не торкнеться
 * контролера — зміниться тільно тіло цього класу.
 */
@Injectable()
export class IdempotencyService<T = unknown> {
  private readonly TTL_MS = 24 * 60 * 60 * 1000;
  private readonly store = new Map<string, Entry<T>>();

  /**
   * Відпечаток тіла, а не саме тіло: питання лише «те саме чи інше».
   *
   * Чесне обмеження: JSON.stringify залежить від порядку ключів. Клієнт, який
   * на retry серіалізує те саме тіло в іншому порядку, отримає 422 на рівному
   * місці. Промислове рішення — канонічний JSON (RFC 8785); приїде на #14.
   */
  fingerprint(body: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }

  get(key: string): Entry<T> | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  markInFlight(key: string, fingerprint: string): void {
    this.store.set(key, { state: 'in-flight', fingerprint, expiresAt: Date.now() + this.TTL_MS });
  }

  markDone(key: string, fingerprint: string, response: T): void {
    this.store.set(key, { state: 'done', fingerprint, response, expiresAt: Date.now() + this.TTL_MS });
  }

  /**
   * Обробник упав — ключ мусить забутись, інакше клієнт застрягне на 409 до
   * кінця TTL на ключі, за яким нічого немає.
   */
  forget(key: string): void {
    this.store.delete(key);
  }

  /**
   * Рішення про долю запиту з цим ключем.
   *
   * Порядок двох перших перевірок НЕ довільний. Відпечаток тіла порівнюється
   * раніше за стан, і це законно тільки тому, що `markInFlight()` пише
   * fingerprint ДО запуску обробника — тобто він достовірний навіть у
   * 'in-flight'. Якби ми писали його лише в `markDone()`, порівнювати в
   * 'in-flight' було б нічого, і порядок став би зворотним примусово.
   *
   * А чому mismatch важливіший за in-flight, коли справдились обидва: «тіло
   * інше» — остаточний факт про клієнта, він не зміниться від очікування;
   * «ще в польоті» — тимчасовий стан сервера. Віддали б 409 — клієнт
   * повторював би запит, який НІКОЛИ не пройде: після завершення першого він
   * усе одно отримає 422, просто витративши N спроб.
   */
  decide(entry: Entry<T> | undefined, fingerprint: string): Verdict {
    if (!entry) return 'proceed';
    if (entry.fingerprint !== fingerprint) return 'mismatch';
    if (entry.state === 'in-flight') return 'in-flight';
    return 'replay';
  }
}
