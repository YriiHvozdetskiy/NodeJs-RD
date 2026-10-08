import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import type { Order } from './order.entity';

/**
 * Ключ ідемпотентності з API-краю (#22, рівень 3) — `Idempotency-Key` з #9,
 * тепер у Postgres, а не в памʼяті процесу.
 *
 * Рядок пишеться в ТІЙ САМІЙ транзакції, що й замовлення, останнім
 * оператором: є замовлення — є ключ, відкотилось одне — відкотилось і друге.
 * Другий запит із тим самим ключем упирається в PK, його транзакція
 * відкочується цілком (разом із другим замовленням і другою подією в outbox), і
 * клієнт отримує вже створене замовлення.
 *
 * Ключ ідентифікує НАМІР, а не тіло: два однакові кошики з різними ключами —
 * два законні замовлення. `fingerprint` (sha256 тіла) тут лише для того, щоб
 * той самий ключ з ІНШИМ тілом дав 422, а не чуже замовлення.
 *
 * Живе 24 години (спека, `Idempotency-Key`): прострочений рядок той самий ключ
 * перезаписує (src/checkout/checkout.ts), а чистить таблицю окремий прохід.
 */
@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'idempotency_keys_pkey' })
  key!: string;

  @Column({ type: 'text' })
  fingerprint!: string;

  @Column({ name: 'order_id', type: 'bigint' })
  orderId!: string;

  /** Ключ без замовлення нічого не відтворить — він іде разом із ним. */
  @ManyToOne('Order', { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'idempotency_keys_order_id_fkey' })
  order!: Relation<Order>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
