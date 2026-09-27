import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import type { Order } from './order.entity';

export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * 1:1 із замовленням — `@OneToOne` + `@JoinColumn` на цьому боці: FK живе в
 * payments, і TypeORM сам додає на order_id UNIQUE (другого платежу на те саме
 * замовлення бути не може). Ресурсом стане на #22 разом із outbox.
 */
@Entity('payments')
@Check('payments_amount_cents_check', `amount_cents > 0`)
@Check('payments_status_check', `status IN ('pending', 'succeeded', 'failed')`)
export class Payment {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
    primaryKeyConstraintName: 'payments_pkey',
  })
  id!: string;

  @Column({ name: 'order_id', type: 'bigint' })
  orderId!: string;

  /** Платіж — незворотна подія з грошима: замовлення, за яке платили, не видалити. */
  @OneToOne('Order', (order: Order) => order.payment, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'payments_order_id_fkey' })
  order!: Relation<Order>;

  @Column({ name: 'amount_cents', type: 'integer' })
  amountCents!: number;

  @Column({ type: 'text', default: 'pending' })
  status!: PaymentStatus;

  @Column({ name: 'provider_ref', type: 'text', nullable: true })
  providerRef!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
