import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Inbox споживача (#22) — ідемпотентність рівня 2: «цю подію цей споживач уже
 * обробив». Рядок вставляється в ТІЙ САМІЙ транзакції, що й ефект: обидва
 * комітяться разом або жоден. Позначка в іншому сховищі (Redis) поруч з
 * ефектом у Postgres була б тим самим dual write, від якого тікав outbox.
 *
 * Ключ складений: одну подію order.placed обробляє кожен підписник окремо, і
 * «бали вже нараховано» не означає «лист уже надіслано». `consumer` — імʼя
 * черги підписника: одна черга — один споживач — один рядок на подію.
 *
 * Рядки старіють: позначку, старшу за найдовше вікно повторної доставки, можна
 * видаляти (README, розділ 13). Ефект балів від цього не задвоїться — під
 * inbox лежить ще й природний ключ `points_entries_one_earned_per_order`.
 */
@Entity('processed_messages')
export class ProcessedMessage {
  @PrimaryColumn({ name: 'message_id', type: 'uuid', primaryKeyConstraintName: 'processed_messages_pkey' })
  messageId!: string;

  @PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'processed_messages_pkey' })
  consumer!: string;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt!: Date;
}
