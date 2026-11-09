import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Principal } from '../auth/access-tokens';
import { HttpProblem } from '../common/http-problem';
import { FileStorage } from './file-storage';
import { FilesRepository, type FileRecord } from './files.repository';
import { isNotFound, type ObjectStorage, type UploadedPart } from './object-storage';
import {
  ALLOWED_TYPES,
  DOWNLOAD_URL_TTL_SEC,
  expectedPartSize,
  isAllowedContentType,
  MAGIC_BYTES,
  MULTIPART_THRESHOLD,
  partCountFor,
  partSizeFor,
  uploadUrlTtlSec,
} from './upload-policy';

export interface IntentInput {
  contentType: string;
  size: number;
  idempotencyKey?: string;
}

export interface PartUrl {
  part_number: number;
  url: string;
}

/** Відповідь intent у формі схеми `UploadIntent` зі спеки. */
export interface UploadIntent {
  file_id: string;
  key: string;
  status: FileRecord['status'];
  mode: 'single' | 'multipart';
  expires_in: number;
  url?: string;
  headers?: Record<string, string>;
  part_size?: number;
  part_count?: number;
  parts?: PartUrl[];
}

/** Відповідь `GET /uploads/{id}/parts` — схема `UploadParts`. */
export interface UploadParts {
  file_id: string;
  part_size: number;
  part_count: number;
  uploaded: number[];
  parts: PartUrl[];
  expires_in: number;
}

/** Схема `StoredFile` зі спеки. */
export interface FileView {
  file_id: string;
  key: string;
  status: FileRecord['status'];
  content_type: string;
  size: number;
  etag: string | null;
}

const ALLOWED_LIST = Object.keys(ALLOWED_TYPES).join(', ');

function view(file: FileRecord): FileView {
  return { file_id: file.id, key: file.key, status: file.status, content_type: file.contentType, size: file.size, etag: file.etag };
}

/**
 * Двокроковий контракт завантаження (#26):
 *
 *   POST /uploads/intent        право, allowlist, ключ від сервера, рядок pending, presigned URL
 *   PUT  <presigned URL>        байти напряму у сховище — повз наш сервіс
 *   POST /uploads/{id}/commit   HeadObject: обʼєкт є, розмір і сигнатура збігаються → completed
 *
 * Сервіс лишається на шляху АВТОРИЗАЦІЇ (кожен intent, commit і download іде
 * через гарди #24), але не на шляху ДАНИХ: жоден байт файла сюди не заходить.
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly files: FilesRepository,
    private readonly storage: FileStorage,
  ) {}

  async intent(principal: Principal, input: IntentInput): Promise<UploadIntent> {
    const storage = this.storage.get();
    const contentType = input.contentType.trim().toLowerCase();
    if (!isAllowedContentType(contentType)) {
      throw new HttpProblem(422, `тип ${contentType} не дозволено; дозволені: ${ALLOWED_LIST}`, 'unprocessable-entity');
    }
    const type = ALLOWED_TYPES[contentType];
    if (input.size > type.maxSize) {
      throw new HttpProblem(422, `${contentType} — щонайбільше ${type.maxSize} Б, заявлено ${input.size} Б`, 'unprocessable-entity');
    }

    // Подвійний тап: той самий Idempotency-Key — той самий рядок і той самий
    // ключ обʼєкта, лише зі свіжими підписами.
    if (input.idempotencyKey) {
      const existing = await this.files.findByIdempotencyKey(principal.userId, input.idempotencyKey);
      if (existing) return this.replay(storage, existing, contentType, input.size);
    }

    // Ключ складає сервер і лише з того, що знає сам: власник із токена, UUID,
    // розширення з allowlist. filename клієнта сюди не доходить узагалі.
    const id = randomUUID();
    const key = `uploads/${principal.userId}/${id}.${type.ext}`;

    // Незавершений multipart тарифікується, хоча обʼєкта ще немає. Тому якщо
    // рядок не вставився, створене завантаження скасовується тут же.
    const uploadId = input.size > MULTIPART_THRESHOLD ? await storage.createMultipart(key, contentType) : null;
    let file: FileRecord | null;
    try {
      file = await this.files.insertPending({
        id,
        ownerId: principal.userId,
        key,
        contentType,
        size: input.size,
        uploadId,
        idempotencyKey: input.idempotencyKey ?? null,
      });
    } catch (err) {
      if (uploadId) await storage.abortMultipart(key, uploadId).catch(() => undefined);
      throw err;
    }
    if (file) return this.sign(storage, file);

    // Паралельний дубль із тим самим ключем ідемпотентності вставився першим.
    if (uploadId) await storage.abortMultipart(key, uploadId);
    const winner = input.idempotencyKey ? await this.files.findByIdempotencyKey(principal.userId, input.idempotencyKey) : null;
    if (!winner) throw new Error(`intent ${id}: рядок не вставлено і переможця конфлікту не знайдено`);
    return this.replay(storage, winner, contentType, input.size);
  }

  /**
   * Відновлення multipart: які частини вже у сховищі і свіжі URL на решту.
   * Стан завантаження живе у сховищі (ListParts), а не в памʼяті клієнта, тому
   * новий процес після SIGKILL старого починає звідси й доливає лише те, чого
   * бракує. Цей самий виклик рятує і завантаження, якому не вистачило строку
   * URL: підписи тут нові.
   */
  async parts(principal: Principal, fileId: string): Promise<UploadParts> {
    const file = await this.owned(principal, fileId);
    if (!file.uploadId) throw new HttpProblem(409, 'файл завантажується одним PUT, частин у нього немає', 'conflict');
    if (file.status === 'completed') throw new HttpProblem(409, 'завантаження вже завершено', 'conflict');
    const storage = this.storage.get();

    let stored: UploadedPart[];
    try {
      stored = await storage.listParts(file.key, file.uploadId);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      throw new HttpProblem(409, 'завантаження у сховищі скасоване — почни заново з intent', 'conflict');
    }
    const uploaded = this.completeParts(file, stored).map((part) => part.partNumber);
    const count = partCountFor(file.size);
    const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !uploaded.includes(n));
    const ttl = uploadUrlTtlSec(file.size);
    return {
      file_id: file.id,
      part_size: partSizeFor(file.size),
      part_count: count,
      uploaded,
      parts: await this.partUrls(storage, file.key, file.uploadId, missing, ttl),
      expires_in: ttl,
    };
  }

  /**
   * Чесний commit. Клієнт каже «я залив» — сервер перевіряє сам: обʼєкт
   * існує, розмір збігається із заявленим, перші байти схожі на заявлений
   * тип. Без HeadObject тут клієнт «комітив» би те, чого не заливав, і в базі
   * зʼявився б completed-файл, якого немає у сховищі.
   */
  async commit(principal: Principal, fileId: string): Promise<FileView> {
    const file = await this.owned(principal, fileId);
    // Повтор commit після таймауту — той самий результат, а не помилка.
    if (file.status === 'completed') return view(file);
    const storage = this.storage.get();

    if (file.uploadId) await this.completeMultipart(storage, file, file.uploadId);

    const head = await storage.head(file.key);
    if (!head) {
      throw new HttpProblem(409, 'у сховищі немає обʼєкта: спершу PUT за URL з intent, потім commit', 'conflict');
    }
    if (head.size !== file.size) {
      throw new HttpProblem(409, `розмір не збігається: заявлено ${file.size} Б, у сховищі ${head.size} Б`, 'conflict');
    }

    // Content-Type від клієнта — лише його слова. Перші байти — факт.
    const contentType = file.contentType;
    const signature = await storage.readHead(file.key, MAGIC_BYTES);
    if (!isAllowedContentType(contentType) || !ALLOWED_TYPES[contentType].magic(signature)) {
      await storage.delete(file.key);
      throw new HttpProblem(422, `вміст не схожий на ${contentType}: сигнатура файла не збігається; обʼєкт видалено`, 'unprocessable-entity');
    }

    // Конкурентний commit міг устигнути першим — тоді беремо його результат.
    const done = (await this.files.markCompleted(file.id, head.etag)) ?? (await this.files.findById(file.id));
    if (!done) throw new Error(`commit ${file.id}: рядок зник посеред commit`);
    return view(done);
  }

  /**
   * `GET /files/{id}` → 302 на свіжий presigned GET на хвилину. Довгоживучий
   * presigned у листі не відкличеш нічим; цей ендпоїнт пропускає кожне
   * відкриття через гард, а сам URL живе рівно стільки, щоб за ним перейти.
   */
  async downloadUrl(principal: Principal, fileId: string): Promise<string> {
    const file = await this.owned(principal, fileId, { allowAdmin: true });
    if (file.status !== 'completed') throw new HttpProblem(409, 'файл ще не завантажено', 'conflict');
    return this.storage.get().presignGet(file.key, DOWNLOAD_URL_TTL_SEC);
  }

  // ─── допоміжне ───────────────────────────────────────────────────────────

  /** Чужий файл — 403, як чуже замовлення (#24); неіснуючий — 404. */
  private async owned(principal: Principal, fileId: string, options: { allowAdmin?: boolean } = {}): Promise<FileRecord> {
    const file = await this.files.findById(fileId);
    if (!file) throw new HttpProblem(404, `файл ${fileId} не знайдено`, 'not-found');
    const isAdmin = options.allowAdmin === true && principal.role === 'admin';
    if (file.ownerId !== principal.userId && !isAdmin) {
      throw new HttpProblem(403, 'файл належить іншому користувачу', 'forbidden');
    }
    return file;
  }

  /** Повтор intent з тим самим Idempotency-Key: тіло мусить бути тим самим. */
  private replay(storage: ObjectStorage, file: FileRecord, contentType: string, size: number): Promise<UploadIntent> {
    if (file.contentType !== contentType || file.size !== size) {
      throw new HttpProblem(422, 'цей Idempotency-Key уже використано з іншим типом або розміром файла', 'idempotency-key-reused');
    }
    return this.sign(storage, file);
  }

  private async sign(storage: ObjectStorage, file: FileRecord): Promise<UploadIntent> {
    const base = { file_id: file.id, key: file.key, status: file.status };
    if (file.status === 'completed') {
      return { ...base, mode: file.uploadId ? 'multipart' : 'single', expires_in: 0 };
    }
    const ttl = uploadUrlTtlSec(file.size);
    if (!file.uploadId) {
      return {
        ...base,
        mode: 'single',
        expires_in: ttl,
        url: await storage.presignPut(file.key, file.contentType, ttl),
        // Тип підписано: PUT з іншим Content-Type сховище відхилить 403.
        headers: { 'content-type': file.contentType },
      };
    }
    const count = partCountFor(file.size);
    const all = Array.from({ length: count }, (_, i) => i + 1);
    return {
      ...base,
      mode: 'multipart',
      expires_in: ttl,
      part_size: partSizeFor(file.size),
      part_count: count,
      parts: await this.partUrls(storage, file.key, file.uploadId, all, ttl),
    };
  }

  private partUrls(storage: ObjectStorage, key: string, uploadId: string, numbers: number[], ttl: number): Promise<PartUrl[]> {
    // Підпис — локальна криптографія, без мережі: сотня URL — мілісекунди.
    return Promise.all(numbers.map(async (n) => ({ part_number: n, url: await storage.presignPart(key, uploadId, n, ttl) })));
  }

  /** Частини з правильними номерами і розмірами. Частину іншого розміру клієнт перезаллє. */
  private completeParts(file: FileRecord, stored: UploadedPart[]): UploadedPart[] {
    const count = partCountFor(file.size);
    return stored
      .filter((part) => part.partNumber >= 1 && part.partNumber <= count && part.size === expectedPartSize(file.size, part.partNumber))
      .sort((a, b) => a.partNumber - b.partNumber);
  }

  /**
   * Склеїти частини. Список частин бере сервер у сховища (ListParts), а не
   * в клієнта: клієнт міг загубити ETag-и разом із процесом, що впав.
   */
  private async completeMultipart(storage: ObjectStorage, file: FileRecord, uploadId: string): Promise<void> {
    let stored: UploadedPart[];
    try {
      stored = await storage.listParts(file.key, uploadId);
    } catch (err) {
      // NoSuchUpload: завантаження вже склеїв конкурентний commit (тоді
      // HeadObject далі знайде обʼєкт) або його скасовано (тоді не знайде).
      if (isNotFound(err)) return;
      throw err;
    }
    const parts = this.completeParts(file, stored);
    const count = partCountFor(file.size);
    if (parts.length !== count) {
      const have = parts.map((part) => part.partNumber).join(',') || 'жодної';
      throw new HttpProblem(409, `не всі частини у сховищі: є ${have} з ${count} — GET /uploads/${file.id}/parts покаже, чого бракує`, 'conflict');
    }
    try {
      await storage.completeMultipart(file.key, uploadId, parts);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}
