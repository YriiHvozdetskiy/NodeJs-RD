import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  type Relation,
} from 'typeorm';
import type { Order } from './order.entity';
import type { PointsEntry } from './points-entry.entity';
import type { Product } from './product.entity';

export const USER_ROLES = ['buyer', 'seller', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * buyer · seller · admin. Ролі розійдуться правами на #24 (RBAC).
 *
 * `bigint` з драйвера `pg` приходить РЯДКОМ: 2^63 не влазить у JS number без
 * втрати точності, тому всі id і FK у entities мають тип `string`.
 *
 * Індекс по lower(email) — expression index, а `@Index` TypeORM уміє лише
 * колонки. Тому він оголошений тут із `synchronize: false` (TypeORM знає про
 * нього й не спробує DROP на наступному migration:generate), а створюється
 * рукописним рядком у міграції.
 */
@Entity('users')
@Unique('users_email_key', ['email'])
@Check('users_role_check', `role IN ('buyer', 'seller', 'admin')`)
@Index('idx_users_email_lower', { synchronize: false })
export class User {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
    primaryKeyConstraintName: 'users_pkey',
  })
  id!: string;

  @Column({ type: 'text' })
  email!: string;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @Column({ type: 'text', default: 'buyer' })
  role!: UserRole;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @OneToMany('Product', (product: Product) => product.seller)
  products!: Relation<Product[]>;

  @OneToMany('Order', (order: Order) => order.buyer)
  orders!: Relation<Order[]>;

  @OneToMany('PointsEntry', (entry: PointsEntry) => entry.user)
  pointsEntries!: Relation<PointsEntry[]>;
}
