import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Transactional outbox (#22): подія, яку бізнес-операція записала в ТІЙ САМІЙ
 * транзакції, що й свої рядки. Брокер не вміє брати участь у COMMIT Postgres,
 * тож «записати замовлення й повідомити світ» зводиться до двох INSERT в один
 * COMMIT, а в брокер подію пізніше везе relay (src/outbox/relay.ts).
 *
 * Поля — ролі Debezium Outbox Event Router, щоб перехід з polling-relay на CDC
 * не змінив консюмерів:
 *   id              → id події = messageId у брокері; тут це eventId (UUID v5
 *                     від orderId), тож другий рядок про те саме замовлення
 *                     впреться в PK;
 *   aggregate_type  → куди маршрутизувати (у Debezium — топік);
 *   aggregate_id    → ключ повідомлення, тобто ключ партиціонування;
 *   type            → тип події, у нас — routing key `order.placed`;
 *   payload         → тіло повідомлення як є: конверт події, а не ORM-сутність.
 * Канонічні імена Debezium — без підкреслення (`aggregatetype`, `aggregateid`),
 * тому в конекторі їх перевизначають: `route.by.field=aggregate_type`,
 * `table.field.event.key=aggregate_id` (README, розділ 13).
 *
 * `published_at` NULL = ще не винесено. `attempts` рахує лише ЗАКОМІЧЕНІ
 * спроби: спроба, після якої relay помер до COMMIT, відкотилась разом із
 * своїм +1 — це видно в demo:crash-relay (дві доставки, attempts = 1).
 *
 * Частковий індекс (created_at, id) WHERE published_at IS NULL — рівно під
 * запит relay: винесені рядки в індекс не потрапляють, тож вибірка
 * «наступні невинесені» не повільнішає з історією. Таблиця ж росте, і чистить
 * її окремий прохід за published_at (README, розділ 13).
 */
@Entity('outbox')
@Index('outbox_unpublished', ['createdAt', 'id'], { where: 'published_at IS NULL' })
@Check('outbox_attempts_check', 'attempts >= 0')
export class OutboxEvent {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'outbox_pkey' })
  id!: string;

  @Column({ name: 'aggregate_type', type: 'text' })
  aggregateType!: string;

  @Column({ name: 'aggregate_id', type: 'text' })
  aggregateId!: string;

  @Column({ type: 'text' })
  type!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** now() — час початку транзакції, тобто та сама мить, що й orders.created_at. */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  /** Чому остання закомічена спроба не вдалась. Скидається в NULL на успіху. */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;
}
