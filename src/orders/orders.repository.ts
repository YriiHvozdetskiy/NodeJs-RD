import { Inject, Injectable } from '@nestjs/common';
import { cursorAt, decodeCursor, toPage, type KeysetRow, type Page } from '../common/cursor';
import { DB, type Queryable } from '../db/queryable';
import type { OrderStatus } from '../entities/order.entity';

/** Позиція замовлення у формі схеми `OrderLine` зі спеки. */
export interface OrderLine {
  product_id: number;
  qty: number;
  unit_price_cents: number;
}

/** Замовлення у формі схеми `Order` зі спеки. */
export interface Order {
  id: number;
  items: OrderLine[];
  total_cents: number;
  currency: string;
  status: OrderStatus;
  created_at: Date;
}

interface OrderRow extends KeysetRow {
  status: OrderStatus;
  currency: string;
  total_cents: number;
  created_at: Date;
  items: OrderLine[];
}

/**
 * Позиції замовлення одним JSON-масивом — агрегація в базі, а не N запитів з
 * коду (той самий N+1 з #13, тільки в HTTP). `bigint` усередині
 * `json_build_object` стає JSON-числом, тож `product_id` приходить числом.
 * FILTER + COALESCE — щоб замовлення без позицій дало `[]`, а не `[null]`:
 * LEFT JOIN без збігу все одно віддає один рядок із NULL-ами.
 */
const ITEMS = `COALESCE(
  json_agg(
    json_build_object('product_id', oi.product_id, 'qty', oi.qty, 'unit_price_cents', oi.unit_price_cents)
    ORDER BY oi.product_id
  ) FILTER (WHERE oi.order_id IS NOT NULL),
  '[]'
)`;

@Injectable()
export class OrdersRepository {
  constructor(@Inject(DB) private readonly db: Queryable) {}

  async findById(id: number): Promise<Order | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    // GROUP BY o.id досить: id — первинний ключ, решта колонок orders від нього
    // функціонально залежні, і Postgres це знає.
    const { rows } = await this.db.query<OrderRow>(
      `SELECT o.id, o.status, o.currency, o.total_cents, o.created_at,
              ${cursorAt('o.created_at')} AS cursor_at,
              ${ITEMS} AS items
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.id = $1
        GROUP BY o.id`,
      [id],
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  /**
   * Спершу сторінка замовлень (CTE з LIMIT), і лише потім JOIN позицій. Якби
   * LIMIT стояв після JOIN, він рахував би рядки order_items, а не замовлення:
   * сторінка «2 замовлення» по 3 позиції обрізала б друге посередині.
   * У CTE немає первинного ключа, тому GROUP BY перелічує всі колонки.
   */
  async page(limit: number, cursor?: string): Promise<Page<Order>> {
    const after = cursor ? decodeCursor(cursor) : undefined;
    const { rows } = await this.db.query<OrderRow>(
      `WITH page AS (
         SELECT id, status, currency, total_cents, created_at, ${cursorAt('created_at')} AS cursor_at
           FROM orders
          ${after ? 'WHERE (created_at, id) < ($2::timestamptz, $3::bigint)' : ''}
          ORDER BY created_at DESC, id DESC
          LIMIT $1
       )
       SELECT p.id, p.status, p.currency, p.total_cents, p.created_at, p.cursor_at, ${ITEMS} AS items
         FROM page p
         LEFT JOIN order_items oi ON oi.order_id = p.id
        GROUP BY p.id, p.status, p.currency, p.total_cents, p.created_at, p.cursor_at
        ORDER BY p.created_at DESC, p.id DESC`,
      after ? [limit + 1, after.c, after.id] : [limit + 1],
    );
    return toPage(rows, limit, toOrder);
  }
}

function toOrder(row: OrderRow): Order {
  return {
    id: Number(row.id),
    items: row.items,
    total_cents: row.total_cents,
    currency: row.currency,
    status: row.status,
    created_at: row.created_at,
  };
}
