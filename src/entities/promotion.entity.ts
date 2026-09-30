import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  type Relation,
} from 'typeorm';
import type { Product } from './product.entity';

export const PROMOTION_KINDS = ['seasonal', 'quantity_tier', 'promo_code'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

/**
 * Три типи акцій. seasonal і quantity_tier прив'язані до товару, promo_code
 * діє на все замовлення і товару не має — це тримають CHECK-и нижче, а не код.
 *
 * *_local — «настінний» час продавця (timestamp без зони навмисно),
 * *_at — та сама мить в абсолюті; по *_at працюють запити.
 *
 * percent_off — відсоток, не гроші: numeric(5,2), приходить рядком.
 */
@Entity('promotions')
@Unique('promotions_code_key', ['code'])
@Check('promotions_kind_check', `kind IN ('seasonal', 'quantity_tier', 'promo_code')`)
@Check('promotions_percent_off_check', `percent_off > 0 AND percent_off <= 100`)
@Check('promotions_min_qty_check', `min_qty > 1`)
@Check('promotions_region_check', `region ~ '^[A-Z]{2}$'`)
@Check('promotions_period_check', `ends_at > starts_at`)
@Check('promotions_local_period_check', `ends_local > starts_local`)
@Check('promotions_product_by_kind_check', `(kind = 'promo_code') = (product_id IS NULL)`)
@Check('promotions_code_by_kind_check', `(kind = 'promo_code') = (code IS NOT NULL)`)
@Check('promotions_min_qty_by_kind_check', `(kind = 'quantity_tier') = (min_qty IS NOT NULL)`)
export class Promotion {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
    primaryKeyConstraintName: 'promotions_pkey',
  })
  id!: string;

  @Column({ name: 'product_id', type: 'bigint', nullable: true })
  productId!: string | null;

  /** Акція без товару втрачає сенс: видалили товар — його акції йдуть слідом. */
  @ManyToOne('Product', (product: Product) => product.promotions, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id', foreignKeyConstraintName: 'promotions_product_id_fkey' })
  product!: Relation<Product> | null;

  @Column({ type: 'text' })
  kind!: PromotionKind;

  @Column({ type: 'text', nullable: true })
  code!: string | null;

  @Column({ name: 'percent_off', type: 'numeric', precision: 5, scale: 2 })
  percentOff!: string;

  @Column({ name: 'min_qty', type: 'integer', nullable: true })
  minQty!: number | null;

  @Column({ type: 'text' })
  region!: string;

  @Column({ type: 'text' })
  timezone!: string;

  @Column({ name: 'starts_local', type: 'timestamp' })
  startsLocal!: Date;

  @Column({ name: 'ends_local', type: 'timestamp' })
  endsLocal!: Date;

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt!: Date;

  @Column({ name: 'ends_at', type: 'timestamptz' })
  endsAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
