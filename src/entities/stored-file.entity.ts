import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, Unique, type Relation } from 'typeorm';
import type { User } from './user.entity';

export const FILE_STATUSES = ['pending', 'completed'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/**
 * Файл у сховищі (#26) — запис бази про обʼєкт S3. Список файлів користувача
 * живе тут, а не в листингу бакета: листинг платний, повільний (1 000 ключів
 * за виклик) і нічого не знає про власника чи статус.
 *
 * Життєвий цикл:
 *   pending   — `POST /uploads/intent` видав presigned URL; байтів у сховищі
 *               може й не бути. Такі рядки старші за добу — сироти, їх
 *               прибирає задача (README, розділ Files);
 *   completed — `commit` зробив HeadObject і переконався, що обʼєкт є і його
 *               розмір збігається з заявленим.
 *
 * `id` — той самий UUID, що в ключі `uploads/{owner}/{id}.{ext}`. Генерує
 * його сервер, а не база: ключ потрібен ДО INSERT, щоб підписати URL.
 * `filename` клієнта не зберігається ніде — ні в ключі, ні тут.
 *
 * `upload_id` — лише в multipart: ідентифікатор незавершеного завантаження
 * в сховищі. За ним новий процес клієнта питає ListParts і доливає те, чого
 * бракує.
 *
 * `idempotency_key` — заголовок `Idempotency-Key` з intent: подвійний тап по
 * кнопці повертає той самий рядок і той самий ключ обʼєкта, а не створює
 * другий. UNIQUE на парі з власником: NULL-и в Postgres між собою не
 * конфліктують, тож рядки без заголовка обмеження не зачіпає.
 */
@Entity('files')
@Unique('files_key_key', ['key'])
@Unique('files_owner_idempotency_key', ['ownerId', 'idempotencyKey'])
@Index('idx_files_owner_created', ['ownerId', 'createdAt'])
@Index('idx_files_pending_created', ['createdAt'], { where: `status = 'pending'` })
@Check('files_status_check', `status IN ('pending', 'completed')`)
@Check('files_size_check', `size > 0`)
@Check('files_completed_at_check', `(status = 'completed') = (completed_at IS NOT NULL)`)
export class StoredFile {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'files_pkey' })
  id!: string;

  @Column({ name: 'owner_id', type: 'bigint' })
  ownerId!: string;

  /**
   * RESTRICT, а не CASCADE: рядок — єдине, що памʼятає про обʼєкт у сховищі.
   * Каскад видалив би рядки й лишив обʼєкти сиротами назавжди. Видалення
   * користувача мусить спершу прибрати його файли зі сховища, потім рядки.
   */
  @ManyToOne('User', { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'owner_id', foreignKeyConstraintName: 'files_owner_id_fkey' })
  owner!: Relation<User>;

  @Column({ type: 'text' })
  key!: string;

  @Column({ name: 'content_type', type: 'text' })
  contentType!: string;

  /** Заявлений клієнтом розмір у байтах; commit звіряє його з HeadObject. */
  @Column({ type: 'bigint' })
  size!: string;

  @Column({ type: 'text', default: 'pending' })
  status!: FileStatus;

  @Column({ name: 'upload_id', type: 'text', nullable: true })
  uploadId!: string | null;

  /** ETag зі сховища на момент commit. У multipart це НЕ MD5 файла, а `…-N`. */
  @Column({ type: 'text', nullable: true })
  etag!: string | null;

  @Column({ name: 'idempotency_key', type: 'text', nullable: true })
  idempotencyKey!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
