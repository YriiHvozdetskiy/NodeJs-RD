import type { Queryable } from '../../src/db/queryable';
import type { OrderStatus } from '../../src/entities/order.entity';
import type { ProductCategory } from '../../src/entities/product.entity';
import type { UserRole } from '../../src/entities/user.entity';

/**
 * Test data builders: у тесті видно лише те поле, від якого залежить
 * перевірка, решта — валідні дефолти, які проходять усі CHECK-и схеми.
 * Унікальність email і назв — безкоштовна, з лічильника. Залежності
 * (продавець товару, покупець і товар замовлення) builder створює сам, якщо
 * тест їх не задав.
 *
 * Пишуть напряму SQL-ом, а не через репозиторії: це arrange-фаза, і вона не
 * має залежати від коду, який тест перевіряє.
 */
let seq = 0;
const next = (): number => ++seq;

export interface InsertedUser {
  id: number;
  email: string;
  role: UserRole;
}

export class UserBuilder {
  private email = `user-${next()}@test.local`;
  private role: UserRole = 'buyer';

  withEmail(email: string): this {
    this.email = email;
    return this;
  }

  asSeller(): this {
    this.role = 'seller';
    return this;
  }

  async insert(db: Queryable): Promise<InsertedUser> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, '!', $2) RETURNING id`,
      [this.email, this.role],
    );
    return { id: Number(rows[0].id), email: this.email, role: this.role };
  }
}

export interface InsertedProduct {
  id: number;
  sellerId: number;
  title: string;
  priceCents: number;
  stock: number;
}

export class ProductBuilder {
  private sellerId?: number;
  private title = `Тестовий товар №${next()}`;
  private category: ProductCategory = 'electronics';
  private priceCents = 125_000;
  private stock = 10;
  private createdAtIso?: string;

  bySeller(sellerId: number): this {
    this.sellerId = sellerId;
    return this;
  }

  withPrice(cents: number): this {
    this.priceCents = cents;
    return this;
  }

  withStock(stock: number): this {
    this.stock = stock;
    return this;
  }

  /** ISO-рядок із мікросекундами, якщо тест про точність: `2026-09-30T10:00:00.000100Z`. */
  createdAt(iso: string): this {
    this.createdAtIso = iso;
    return this;
  }

  async insert(db: Queryable): Promise<InsertedProduct> {
    const sellerId = this.sellerId ?? (await aUser().asSeller().insert(db)).id;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO products (seller_id, category, title, price_cents, stock, created_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
       RETURNING id`,
      [sellerId, this.category, this.title, this.priceCents, this.stock, this.createdAtIso ?? null],
    );
    return { id: Number(rows[0].id), sellerId, title: this.title, priceCents: this.priceCents, stock: this.stock };
  }
}

export interface OrderLineSpec {
  productId: number;
  qty: number;
  unitPriceCents: number;
}

export interface InsertedOrder {
  id: number;
  buyerId: number;
  totalCents: number;
  lines: OrderLineSpec[];
}

export class OrderBuilder {
  private buyerId?: number;
  private readonly lines: OrderLineSpec[] = [];
  private status: OrderStatus = 'pending';
  private createdAtIso?: string;

  byBuyer(buyerId: number): this {
    this.buyerId = buyerId;
    return this;
  }

  /** Позиція за ціною товару — так само, як її знімає checkout. */
  withLine(product: Pick<InsertedProduct, 'id' | 'priceCents'>, qty = 1): this {
    this.lines.push({ productId: product.id, qty, unitPriceCents: product.priceCents });
    return this;
  }

  withStatus(status: OrderStatus): this {
    this.status = status;
    return this;
  }

  createdAt(iso: string): this {
    this.createdAtIso = iso;
    return this;
  }

  async insert(db: Queryable): Promise<InsertedOrder> {
    const buyerId = this.buyerId ?? (await aUser().insert(db)).id;
    if (this.lines.length === 0) this.withLine(await aProduct().insert(db));

    // Без знижок: total = subtotal, і CHECK orders_total_consistency_check задоволений.
    const totalCents = this.lines.reduce((sum, line) => sum + line.unitPriceCents * line.qty, 0);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO orders (buyer_id, region, status, currency, subtotal_cents, discount_cents, total_cents, created_at)
       VALUES ($1, 'UA', $2, 'UAH', $3, 0, $3, COALESCE($4::timestamptz, now()))
       RETURNING id`,
      [buyerId, this.status, totalCents, this.createdAtIso ?? null],
    );
    const id = Number(rows[0].id);

    for (const line of this.lines) {
      await db.query(
        `INSERT INTO order_items (order_id, product_id, qty, unit_price_cents) VALUES ($1, $2, $3, $4)`,
        [id, line.productId, line.qty, line.unitPriceCents],
      );
    }
    return { id, buyerId, totalCents, lines: [...this.lines] };
  }
}

export const aUser = (): UserBuilder => new UserBuilder();
export const aProduct = (): ProductBuilder => new ProductBuilder();
export const anOrder = (): OrderBuilder => new OrderBuilder();
