import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import type { Promotion } from './promotion.entity';
import type { User } from './user.entity';

export const PRODUCT_CATEGORIES = ['shoes', 'clothing', 'electronics', 'home', 'sports', 'books'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/**
 * Каталог. Ціна — integer у копійках: `price_cents = 125000` це 1250.00 UAH.
 * Integer проходить від бази до JSON одним типом і ніде не стає float;
 * `numeric` драйвер `pg` віддав би рядком '1250.00'.
 * Межа int4 — 21 474 836.47 UAH за одиницю товару, для маркетплейса досить.
 *
 * rating_avg — не гроші, а середня оцінка, тому лишається numeric(3,2) і
 * приходить рядком. NULL, поки немає жодного відгуку (CHECK нижче тримає це
 * разом із rating_count).
 *
 * search_vector — генерована STORED-колонка: Postgres перераховує її сам на
 * кожен INSERT/UPDATE. `select: false` — вона потрібна лише для WHERE у
 * пошуку, тягнути tsvector у кожен find() немає сенсу. GIN-індекс по ній
 * TypeORM описати не вміє (`@Index` не має USING), тому `synchronize: false`
 * і рукописний CREATE INDEX у міграції.
 */
@Entity('products')
@Check('products_category_check', `category IN ('shoes', 'clothing', 'electronics', 'home', 'sports', 'books')`)
@Check('products_title_check', `length(title) BETWEEN 1 AND 200`)
@Check('products_price_cents_check', `price_cents >= 0`)
@Check('products_currency_check', `currency ~ '^[A-Z]{3}$'`)
@Check('products_stock_check', `stock >= 0`)
@Check('products_rating_avg_check', `rating_avg BETWEEN 1 AND 5`)
@Check('products_rating_count_check', `rating_count >= 0`)
@Check('products_rating_consistency_check', `(rating_count = 0) = (rating_avg IS NULL)`)
@Index('idx_products_search_vector', { synchronize: false })
export class Product {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
    primaryKeyConstraintName: 'products_pkey',
  })
  id!: string;

  @Column({ name: 'seller_id', type: 'bigint' })
  sellerId!: string;

  /** Продавця не видалити, поки в нього є товари: каталог не лишається без власника. */
  @ManyToOne('User', (user: User) => user.products, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'seller_id', foreignKeyConstraintName: 'products_seller_id_fkey' })
  seller!: Relation<User>;

  @Column({ type: 'text' })
  category!: ProductCategory;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', default: '' })
  description!: string;

  @Column({ name: 'price_cents', type: 'integer' })
  priceCents!: number;

  @Column({ type: 'text', default: 'UAH' })
  currency!: string;

  @Column({ type: 'integer', default: 0 })
  stock!: number;

  @Column({ name: 'rating_avg', type: 'numeric', precision: 3, scale: 2, nullable: true })
  ratingAvg!: string | null;

  @Column({ name: 'rating_count', type: 'integer', default: 0 })
  ratingCount!: number;

  @Column({ name: 'image_keys', type: 'text', array: true, default: () => `'{}'` })
  imageKeys!: string[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({
    name: 'search_vector',
    type: 'tsvector',
    generatedType: 'STORED',
    asExpression: `to_tsvector('simple', title || ' ' || description)`,
    nullable: true,
    select: false,
    insert: false,
    update: false,
  })
  searchVector!: string | null;

  @OneToMany('Promotion', (promotion: Promotion) => promotion.product)
  promotions!: Relation<Promotion[]>;
}
