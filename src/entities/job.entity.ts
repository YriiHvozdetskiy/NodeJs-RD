import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const JOB_KINDS = ['order_receipt', 'demo'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_STATUSES = ['pending', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Черга фонових задач у Postgres. Задачу кладе checkout у ТІЙ САМІЙ транзакції,
 * що й замовлення: є замовлення — є задача на чек, відкотилось одне — відкотилось
 * і друге. Розбирають воркери через `FOR UPDATE SKIP LOCKED` (src/queue/worker.ts).
 *
 * Таблиця свідомо без FK на orders: черга не знає про домен, у payload лежить
 * будь-що, що потрібно обробнику. На #19/#22 її замінять RabbitMQ + outbox.
 *
 * `processed` — лічильник обробок, а не прапорець. Інваріант «рівно один раз»
 * перевіряється як `processed = 1` у кожного done-рядка; CHECK (processed <= 1)
 * тут навмисно немає — подвійна обробка має бути видимою цифрою, а не помилкою,
 * яку хтось перехопить і забуде.
 *
 * Partial-індекс по (run_at, id) лише для pending — рівно під запит воркера:
 * виконані задачі накопичуються, але в індекс не потрапляють, тож вибірка
 * «наступна вільна» не повільнішає з історією.
 */
@Entity('jobs')
@Index('idx_jobs_pending', ['runAt', 'id'], { where: `status = 'pending'` })
@Check('jobs_kind_check', `kind IN ('order_receipt', 'demo')`)
@Check('jobs_status_check', `status IN ('pending', 'done', 'failed')`)
@Check('jobs_attempts_check', `attempts >= 0`)
@Check('jobs_max_attempts_check', `max_attempts > 0`)
@Check('jobs_processed_check', `processed >= 0`)
@Check('jobs_done_at_by_status_check', `(status = 'done') = (done_at IS NOT NULL)`)
export class Job {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
    primaryKeyConstraintName: 'jobs_pkey',
  })
  id!: string;

  @Column({ type: 'text' })
  kind!: JobKind;

  @Column({ type: 'jsonb', default: () => `'{}'` })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', default: 'pending' })
  status!: JobStatus;

  /** Скільки разів задачу брали в роботу, включно з невдалими спробами. */
  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'max_attempts', type: 'integer', default: 5 })
  maxAttempts!: number;

  /** Скільки разів задачу успішно ЗАКОМІЧЕНО як виконану. Має бути рівно 1. */
  @Column({ type: 'integer', default: 0 })
  processed!: number;

  @Column({ name: 'processed_by', type: 'text', nullable: true })
  processedBy!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  /** Не раніше за цю мить: після невдалої спроби воркер відсуває задачу з backoff. */
  @Column({ name: 'run_at', type: 'timestamptz', default: () => 'now()' })
  runAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'done_at', type: 'timestamptz', nullable: true })
  doneAt!: Date | null;
}
