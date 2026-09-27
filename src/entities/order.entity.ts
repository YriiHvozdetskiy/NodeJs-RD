import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import type { OrderItem } from './order-item.entity';
import type { Payment } from './payment.entity';
import type { PointsEntry } from './points-entry.entity';
import type { Promotion } from './promotion.entity';
import type { User } from './user.entity';

export const ORDER_STATUSES = ['pending', 'paid', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Точка входу транзакції (#14). Три суми замість однієї, щоб підсумок був
 * прозорий; total = subtotal - discount тримає CHECK, а не код.
 * points_spent окремо від discount: бали не змінюють ціну, вони покривають
 * частину суми до сплати.
 *
 * Два індекси — рівно під запити з #12 (db/queries/q1, q2):
 *   • складений (buyer_id, created_at, id) — «мої замовлення за період»;
 *   • partial по created_at лише для pending — черга «зависших».
 */
@Entity('orders')
@Index('idx_orders_buyer_created', ['buyerId', 'createdAt', 'id'])
@Index('idx_orders_pending_created', ['createdAt'], { where: `status = 'pending'` })
@Check('orders_region_check', `region ~ '^[A-Z]{2}$'`)
@Check('orders_status_check', `status IN ('pending', 'paid', 'cancelled')`)
@Check('orders_currency_check', `currency ~ '^[A-Z]{3}$'`)
@Check('orders_subtotal_cents_check', `subtotal_cents >= 0`)
@Check('orders_discount_cents_check', `discount_cents >= 0`)
@Check('orders_total_cents_check', `total_cents >= 0`)
@Check('orders_points_spent_check', `points_spent >= 0`)
@Check('orders_total_consistency_check', `total_cents = subtotal_cents - discount_cents`)
export class Order {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
    primaryKeyConstraintName: 'orders_pkey',
  })
  id!: string;

  @Column({ name: 'buyer_id', type: 'bigint' })
  buyerId!: string;

  /** Історія покупок переживає будь-які зміни акаунта: покупця з замовленнями не видалити. */
  @ManyToOne('User', (user: User) => user.orders, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'buyer_id', foreignKeyConstraintName: 'orders_buyer_id_fkey' })
  buyer!: Relation<User>;

  @Column({ name: 'device_id', type: 'text', nullable: true })
  deviceId!: string | null;

  @Column({ type: 'text' })
  region!: string;

  @Column({ type: 'text', default: 'pending' })
  status!: OrderStatus;

  @Column({ type: 'text', default: 'UAH' })
  currency!: string;

  @Column({ name: 'subtotal_cents', type: 'integer' })
  subtotalCents!: number;

  @Column({ name: 'discount_cents', type: 'integer', default: 0 })
  discountCents!: number;

  @Column({ name: 'total_cents', type: 'integer' })
  totalCents!: number;

  @Column({ name: 'points_spent', type: 'integer', default: 0 })
  pointsSpent!: number;

  @Column({ name: 'promo_code_id', type: 'bigint', nullable: true })
  promoCodeId!: string | null;

  /** Застосований промокод — частина історії замовлення: акцію, яку вже використали, не видалити. */
  @ManyToOne('Promotion', { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'promo_code_id', foreignKeyConstraintName: 'orders_promo_code_id_fkey' })
  promoCode!: Relation<Promotion> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @OneToMany('OrderItem', (item: OrderItem) => item.order)
  items!: Relation<OrderItem[]>;

  @OneToOne('Payment', (payment: Payment) => payment.order)
  payment!: Relation<Payment> | null;

  @OneToMany('PointsEntry', (entry: PointsEntry) => entry.order)
  pointsEntries!: Relation<PointsEntry[]>;
}
