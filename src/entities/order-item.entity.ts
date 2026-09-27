import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import type { Order } from './order.entity';
import type { Product } from './product.entity';
import type { Promotion } from './promotion.entity';

/**
 * Order ↔ Product — це M:N, але НЕ `@ManyToMany`: на самому зв'язку живуть
 * дані (qty, ціна й знижка на момент покупки). `@ManyToMany` створив би
 * безіменну таблицю з двох FK, куди ці колонки не покласти. Тому зв'язок
 * розгорнуто у явну join-entity = 1:N від Order + N:1 до Product.
 *
 * Власного id немає: позиція — частина агрегату Order, її ідентичність —
 * пара (order_id, product_id), вона ж PK. Один товар у замовленні — один рядок.
 *
 * unit_price_cents і discount_cents — знімок на момент оформлення. Новий
 * цінник чи закінчена акція історію не переписують.
 */
@Entity('order_items')
@Check('order_items_qty_check', `qty > 0`)
@Check('order_items_unit_price_cents_check', `unit_price_cents >= 0`)
@Check('order_items_discount_cents_check', `discount_cents >= 0 AND discount_cents <= unit_price_cents * qty`)
@Check('order_items_promotion_consistency_check', `(promotion_id IS NULL) = (discount_cents = 0)`)
export class OrderItem {
  @PrimaryColumn({ name: 'order_id', type: 'bigint', primaryKeyConstraintName: 'order_items_pkey' })
  orderId!: string;

  @PrimaryColumn({ name: 'product_id', type: 'bigint', primaryKeyConstraintName: 'order_items_pkey' })
  productId!: string;

  /** Позиція без замовлення не має сенсу: видалили замовлення — позиції йдуть разом із ним. */
  @ManyToOne('Order', (order: Order) => order.items, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'order_items_order_id_fkey' })
  order!: Relation<Order>;

  /** Товар, який хтось купив, видалити не можна — інакше зникне рядок з чужої історії покупок. */
  @ManyToOne('Product', { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id', foreignKeyConstraintName: 'order_items_product_id_fkey' })
  product!: Relation<Product>;

  @Column({ type: 'integer' })
  qty!: number;

  @Column({ name: 'unit_price_cents', type: 'integer' })
  unitPriceCents!: number;

  @Column({ name: 'discount_cents', type: 'integer', default: 0 })
  discountCents!: number;

  @Column({ name: 'promotion_id', type: 'bigint', nullable: true })
  promotionId!: string | null;

  /** Акція, за якою дали знижку, лишається доказом цієї знижки. */
  @ManyToOne('Promotion', { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'promotion_id', foreignKeyConstraintName: 'order_items_promotion_id_fkey' })
  promotion!: Relation<Promotion> | null;
}
