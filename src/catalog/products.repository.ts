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

/**
 * Картка товару — схема `ProductCard` зі спеки. `created_at` тут рядок ISO, а
 * не Date: картка їде через кеш (src/catalog/product-cards.service.ts), і після
 * JSON-раунду Date однаково став би рядком. Тип не бреше ні до кешу, ні після.
 */
export interface ProductCard {
  id: number;
  title: string;
  price_cents: number;
  currency: string;
  created_at: string;
  stock: number;
  rating_avg: number | null;
  rating_count: number;
  units_ordered: number;
}

interface ProductCardRow {
  id: string;
  title: string;
  price_cents: number;
  currency: string;
  created_at: Date;
  stock: number;
  rating_avg: string | null;
  rating_count: number;
  units_ordered: number;
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

  /**
   * Картка — те саме, що findById, плюс залишок, рейтинг і «скільки штук
   * замовили». Саме останнє робить читання важким: PK order_items —
   * (order_id, product_id), product_id у ньому другий, і Postgres 17 не вміє
   * шукати по другій колонці B-tree. Тож кожна картка — Seq Scan по всіх
   * order_items. Індекс на product_id прибрав би це, але тоді кешувати було б
   * нічого; тут читання свідомо лишається дорогим, а кеш — його ліками.
   *
   * Замовлення не відфільтровані за статусом: це «скільки разів брали в
   * кошик», а не «скільки продано». Тому скасування картку не змінює.
   */
  async findCard(id: number): Promise<ProductCard | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const { rows } = await this.db.query<ProductCardRow>(
      `SELECT p.id, p.title, p.price_cents, p.currency, p.created_at,
              p.stock, p.rating_avg, p.rating_count,
              (SELECT COALESCE(sum(oi.qty), 0) FROM order_items oi WHERE oi.product_id = p.id)::int AS units_ordered
         FROM products p
        WHERE p.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      title: row.title,
      price_cents: row.price_cents,
      currency: row.currency,
      created_at: row.created_at.toISOString(),
      stock: row.stock,
      // numeric(3,2) драйвер віддає рядком, щоб не губити точність; для 1.00–5.00
      // Number точний.
      rating_avg: row.rating_avg === null ? null : Number(row.rating_avg),
      rating_count: row.rating_count,
      units_ordered: row.units_ordered,
    };
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
