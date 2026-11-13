import { Inject, Injectable } from '@nestjs/common';
import { DB, type Queryable } from '../db/queryable';
import type { FileStatus } from '../entities/stored-file.entity';

export interface FileRecord {
  id: string;
  ownerId: string;
  key: string;
  contentType: string;
  size: number;
  status: FileStatus;
  uploadId: string | null;
  etag: string | null;
  idempotencyKey: string | null;
}

interface FileRow {
  id: string;
  owner_id: string;
  key: string;
  content_type: string;
  /** bigint pg віддає рядком: JS-число не вміщує весь діапазон int8. */
  size: string;
  status: FileStatus;
  upload_id: string | null;
  etag: string | null;
  idempotency_key: string | null;
}

const COLUMNS = 'id, owner_id, key, content_type, size, status, upload_id, etag, idempotency_key';

/** Розміри файлів у нас ≤ 1 ГіБ (src/files/upload-policy.ts) — Number() тут точний. */
function toRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    key: row.key,
    contentType: row.content_type,
    size: Number(row.size),
    status: row.status,
    uploadId: row.upload_id,
    etag: row.etag,
    idempotencyKey: row.idempotency_key,
  };
}

export interface NewFile {
  id: string;
  ownerId: string;
  key: string;
  contentType: string;
  size: number;
  uploadId: string | null;
  idempotencyKey: string | null;
}

@Injectable()
export class FilesRepository {
  constructor(@Inject(DB) private readonly db: Queryable) {}

  async findById(id: string): Promise<FileRecord | null> {
    const { rows } = await this.db.query<FileRow>(`SELECT ${COLUMNS} FROM files WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<FileRecord | null> {
    const { rows } = await this.db.query<FileRow>(`SELECT ${COLUMNS} FROM files WHERE owner_id = $1 AND idempotency_key = $2`, [
      ownerId,
      idempotencyKey,
    ]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Новий pending-рядок. На конфлікті ключа ідемпотентності — нічого і null:
   * паралельний дубль intent устиг першим, і відповісти треба ЙОГО рядком.
   * DO NOTHING без цілі конфлікту свідомо не пишемо: колізія `key` (UUID) —
   * це баг, і вона має впасти, а не мовчки зникнути.
   */
  async insertPending(file: NewFile): Promise<FileRecord | null> {
    const { rows } = await this.db.query<FileRow>(
      `INSERT INTO files (id, owner_id, key, content_type, size, upload_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (owner_id, idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [file.id, file.ownerId, file.key, file.contentType, file.size, file.uploadId, file.idempotencyKey],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * pending → completed. Умова `status = 'pending'` робить перехід
   * одноразовим: два конкурентні commit не перезапишуть etag один одному, а
   * другий отримає null і перечитає рядок.
   */
  async markCompleted(id: string, etag: string): Promise<FileRecord | null> {
    const { rows } = await this.db.query<FileRow>(
      `UPDATE files SET status = 'completed', etag = $2, completed_at = now()
        WHERE id = $1 AND status = 'pending'
       RETURNING ${COLUMNS}`,
      [id, etag],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
