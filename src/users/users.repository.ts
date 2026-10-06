import { Inject, Injectable } from '@nestjs/common';
import { DB, type Queryable } from '../db/queryable';

@Injectable()
export class UsersRepository {
  constructor(@Inject(DB) private readonly db: Queryable) {}

  /**
   * Id покупця з цим email; якщо такого немає — створює. Один оператор, без
   * «SELECT, а якщо порожньо — INSERT»: між ними інший запит устиг би вставити
   * той самий email, і другий INSERT упав би на `users_email_key`.
   *
   * DO UPDATE, а не DO NOTHING, заради RETURNING: DO NOTHING на конфлікті не
   * повертає жодного рядка, і id довелося б читати другим запитом — із тим
   * самим вікном. Ціна — нова версія рядка на кожен виклик, тому
   * `OrdersService` кешує результат і викликає це раз на процес.
   *
   * `ON CONFLICT (email)` компілюється лише тому, що на email є UNIQUE: без
   * нього Postgres відмовив би ще на етапі плану (42P10).
   *
   * Пароль `!` — не хеш, а заборона входу, як `!` у /etc/shadow: жоден пароль
   * під нього не підійде. Покупець-гість існує лише як власник замовлень.
   */
  async ensureBuyer(email: string): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, '!', 'buyer')
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [email],
    );
    return rows[0].id;
  }
}
