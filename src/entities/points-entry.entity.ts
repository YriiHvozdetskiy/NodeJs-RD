import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import type { Order } from './order.entity';
import type { User } from './user.entity';

export const POINTS_KINDS = ['earned', 'spent'] as const;
export type PointsKind = (typeof POINTS_KINDS)[number];
export const POINTS_STATUSES = ['pending', 'available', 'spent'] as const;
export type PointsStatus = (typeof POINTS_STATUSES)[number];

/**
 * Бонусні бали як append-only журнал: баланс = SUM по записах, а не колонка
 * на користувачі. amount завжди додатний, напрямок задає kind. Нарахування
 * (earned) має дату дозрівання, списання (spent) — ні, і воно одразу spent.
 *
 * amount — бали, не гроші, тому без суфікса _cents.
 *
 * Індекс по user_id з'явився на #14: баланс рахується SUM-ом по журналу
 * користувача під його локом у checkout. Без індексу це seq scan усього
 * журналу, і лок тримався б тим довше, чим більше в системі записів.
 *
 * `points_entries_one_earned_per_order` (#19) — не для швидкості, а для
 * правила «одне нарахування на замовлення». Нараховує тепер споживач
 * order.placed, а брокер доставляє at-least-once: повторна доставка тієї самої
 * події впирається в індекс і дає `ON CONFLICT DO NOTHING`, а не другі бали.
 * Partial — бо на тому самому замовленні законно живе ще й рядок `spent`,
 * якщо його частково оплатили балами.
 */
@Entity('points_entries')
@Index('idx_points_entries_user', ['userId'])
@Index('points_entries_one_earned_per_order', ['orderId'], { unique: true, where: `kind = 'earned'` })
@Check('points_entries_kind_check', `kind IN ('earned', 'spent')`)
@Check('points_entries_amount_check', `amount > 0`)
@Check('points_entries_status_check', `status IN ('pending', 'available', 'spent')`)
@Check('points_entries_matures_by_kind_check', `(kind = 'earned') = (matures_at IS NOT NULL)`)
@Check('points_entries_spent_status_check', `kind = 'earned' OR status = 'spent'`)
export class PointsEntry {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
    primaryKeyConstraintName: 'points_entries_pkey',
  })
  id!: string;

  @Column({ name: 'user_id', type: 'bigint' })
  userId!: string;

  /** Журнал — бухгалтерія: власника записів не видалити, інакше баланс зникне без сліду. */
  @ManyToOne('User', (user: User) => user.pointsEntries, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'points_entries_user_id_fkey' })
  user!: Relation<User>;

  @Column({ name: 'order_id', type: 'bigint', nullable: true })
  orderId!: string | null;

  /** Замовлення, за яке нарахували чи списали бали, — підстава запису; видаляти його не можна. */
  @ManyToOne('Order', (order: Order) => order.pointsEntries, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'points_entries_order_id_fkey' })
  order!: Relation<Order> | null;

  @Column({ type: 'text' })
  kind!: PointsKind;

  @Column({ type: 'integer' })
  amount!: number;

  @Column({ type: 'text' })
  status!: PointsStatus;

  @Column({ name: 'matures_at', type: 'timestamptz', nullable: true })
  maturesAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
