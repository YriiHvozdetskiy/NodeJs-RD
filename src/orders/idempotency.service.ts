import { Inject, Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { IDEMPOTENCY_TTL_HOURS } from '../checkout/checkout';
import { DB, type Queryable } from '../db/queryable';

export type Verdict =
  | { kind: 'proceed' }
  | { kind: 'replay'; orderId: number }
  | { kind: 'in-flight' }
  | { kind: 'mismatch' };

/**
 * Ключі ідемпотентності POST /v1/orders — два сховища, і в кожного своя роль.
 *
 *   • Postgres, `idempotency_keys` (#22) — джерело правди про ЗАВЕРШЕНІ
 *     запити. Рядок комітиться в транзакції замовлення (src/checkout/checkout.ts),
 *     тож «замовлення є, ключа немає» не буває. Переживає рестарт, спільний
 *     для всіх інстансів, а паралельний дубль на іншому інстансі зупиняє PK.
 *
 *   • Map у памʼяті — лише «ще в польоті» на ЦЬОМУ інстансі, для `409` зі
 *     спеки. Це не гарантія, а ввічливість: дубль на іншому інстансі сюди не
 *     потрапить, пройде свою транзакцію й відкотиться на PK ключа. Втратити
 *     вміст Map після рестарту безпечно — незавершений запит рестарт однаково
 *     обірвав, і його транзакція відкотилась.
 *
 * До #22 тут була лише Map, і після рестарту той самий ключ створював друге
 * замовлення.
 */
@Injectable()
export class IdempotencyService {
  private readonly inFlight = new Map<string, string>();

  constructor(@Inject(DB) private readonly db: Queryable) {}

  /**
   * Відпечаток тіла, а не саме тіло: питання лише «те саме чи інше». Ключ
   * запису — сам Idempotency-Key: він ідентифікує намір. Хеш тіла як ключ
   * склеїв би два законні однакові замовлення в одне.
   *
   * Чесне обмеження: JSON.stringify залежить від порядку ключів. Клієнт, який
   * на retry серіалізує те саме тіло в іншому порядку, отримає 422 на рівному
   * місці. Промислове рішення — канонічний JSON (RFC 8785).
   */
  fingerprint(body: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }

  /**
   * Рішення про долю запиту з цим ключем.
   *
   * Спершу база: завершений запит — остаточний факт, і він важливіший за
   * будь-що в памʼяті. Далі «в польоті». В обох випадках відпечаток тіла
   * порівнюється раніше за стан: «тіло інше» — остаточний факт про клієнта, він
   * не зміниться від очікування; «ще в польоті» — тимчасовий стан сервера.
   * Віддали б 409 — клієнт повторював би запит, який НІКОЛИ не пройде.
   */
  async decide(key: string, fingerprint: string): Promise<Verdict> {
    const { rows } = await this.db.query<{ fingerprint: string; order_id: string }>(
      `SELECT fingerprint, order_id
         FROM idempotency_keys
        WHERE key = $1 AND created_at > now() - make_interval(hours => $2)`,
      [key, IDEMPOTENCY_TTL_HOURS],
    );
    const [stored] = rows;
    if (stored) return stored.fingerprint === fingerprint ? { kind: 'replay', orderId: Number(stored.order_id) } : { kind: 'mismatch' };

    const running = this.inFlight.get(key);
    if (running === undefined) return { kind: 'proceed' };
    return running === fingerprint ? { kind: 'in-flight' } : { kind: 'mismatch' };
  }

  markInFlight(key: string, fingerprint: string): void {
    this.inFlight.set(key, fingerprint);
  }

  /** Запит завершився — успіхом (ключ уже в базі) або збоєм (ключа немає, клієнт може повторити). */
  release(key: string): void {
    this.inFlight.delete(key);
  }
}
