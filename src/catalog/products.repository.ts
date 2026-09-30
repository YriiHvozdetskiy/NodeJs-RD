import { Inject, Injectable } from '@nestjs/common';
import { cursorAt, decodeCursor, toPage, type KeysetRow, type Page } from '../common/cursor';
import { DB, type Queryable } from '../db/queryable';

/** Товар у формі схеми `Product` зі спеки: snake_case, id числом. */
export interface Product {
  id: number;
  title: string;
  price_cents: number;
  currency: string;
  created_at: Date;
}

interface ProductRow extends KeysetRow {
  title: string;
  price_cents: number;
  currency: string;
  created_at: Date;
}

const COLUMNS = `id, title, price_cents, currency, created_at, ${cursorAt('created_at')} AS cursor_at`;

/**
 * Каталог із Postgres. Приймає `Queryable`, а не пул: у тестах сюди приходить
 * клієнт із відкритою транзакцією, яку тест відкочує (див. src/db/queryable.ts).
 */
@Injectable()
export class ProductsRepository {
  constructor(@Inject(DB) private readonly db: Queryable) {}

  async findById(id: number): Promise<Product | null> {
    // Спека обмежує id лише знизу. 1e20 після ParseIntPipe — валідне число JS,
    // але не bigint: Postgres відповів би помилкою, а клієнт отримав би 500
    // замість чесного «такого товару немає».
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const { rows } = await this.db.query<ProductRow>(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [id]);
    return rows[0] ? toProduct(rows[0]) : null;
  }

  /** Найновіші спершу; id — tie-breaker, той самий, що всередині курсора. */
  async page(limit: number, cursor?: string): Promise<Page<Product>> {
    const after = cursor ? decodeCursor(cursor) : undefined;
    const { rows } = await this.db.query<ProductRow>(
      `SELECT ${COLUMNS}
         FROM products
        ${after ? 'WHERE (created_at, id) < ($2::timestamptz, $3::bigint)' : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      after ? [limit + 1, after.c, after.id] : [limit + 1],
    );
    return toPage(rows, limit, toProduct);
  }
}

function toProduct(row: ProductRow): Product {
  // bigint з драйвера — рядок. Для id каталогу Number безпечний: до 2^53 далеко.
  return { id: Number(row.id), title: row.title, price_cents: row.price_cents, currency: row.currency, created_at: row.created_at };
}
