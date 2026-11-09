import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { envSchema, vaultSchema } from '../config/env.schema';

/**
 * Сховище файлів (#26) — тонка обгортка над S3 API, без Nest. Її ділять три
 * процеси: застосунок (intent / commit), кеш-шар (src/edge.ts) і демо.
 *
 * Вендора тут немає: RustFS із compose, AWS S3, R2 — та сама форма клієнта,
 * міняється лише endpoint.
 */

/**
 * Тиждень на незавершений multipart. Довше за будь-яке живе завантаження
 * (строк URL — година, resume підписує нові), коротше за рахунок, який
 * встигне накопичитись.
 */
const ABORT_INCOMPLETE_AFTER_DAYS = 7;

export interface StorageOptions {
  bucket: string;
  region: string;
  /** Порожньо — справжній AWS S3. */
  endpoint?: string;
  /** Порожньо — ланцюжок провайдерів SDK: IAM-роль на AWS, профіль на машині. */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export interface ObjectInfo {
  size: number;
  etag: string;
  contentType?: string;
  cacheControl?: string;
}

export interface StoredObject extends ObjectInfo {
  body: Buffer;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/** Змінні сховища — підмножина тих самих zod-схем, що валідують застосунок. */
const storageEnvSchema = envSchema
  .pick({ STORAGE_ENDPOINT: true, STORAGE_REGION: true, STORAGE_BUCKET: true })
  .extend(vaultSchema.pick({ STORAGE_ACCESS_KEY: true, STORAGE_SECRET_KEY: true }).shape);

type StorageEnv = z.infer<typeof storageEnvSchema>;

/** Опції з уже провалідованих значень; без бакета сховища немає — undefined. */
export function storageOptionsFrom(env: StorageEnv): StorageOptions | undefined {
  if (!env.STORAGE_BUCKET) return undefined;
  return {
    bucket: env.STORAGE_BUCKET,
    region: env.STORAGE_REGION,
    endpoint: env.STORAGE_ENDPOINT,
    credentials:
      env.STORAGE_ACCESS_KEY && env.STORAGE_SECRET_KEY
        ? { accessKeyId: env.STORAGE_ACCESS_KEY, secretAccessKey: env.STORAGE_SECRET_KEY }
        : undefined,
  };
}

/**
 * 404 від сховища — «такого немає», хоч би як його назвали: NotFound,
 * NoSuchKey, NoSuchUpload. Порівнюємо статус, а не рядок коду: коди помилок
 * між S3-сумісними сховищами ніхто не стандартизував.
 */
export function isNotFound(err: unknown): boolean {
  return err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404;
}

export class ObjectStorage {
  readonly bucket: string;
  readonly s3: S3Client;
  private readonly endpoint?: string;
  private readonly region: string;

  constructor(options: StorageOptions) {
    this.bucket = options.bucket;
    this.endpoint = options.endpoint;
    this.region = options.region;
    this.s3 = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      // Емулятори віддають бакет шляхом (`/bucket/key`), а не піддоменом.
      // На AWS virtual-hosted-style — норма, тому лише з власним endpoint.
      forcePathStyle: Boolean(options.endpoint),
      credentials: options.credentials,
      // 🔴 З кінця 2024 SDK рахує CRC32 кожного завантаження. Presigned
      // підписується, коли тіла ще немає, і в URL поїхала б сума нуля байтів.
      // WHEN_REQUIRED — контрольна сума лише там, де її вимагає сам API.
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  /** CLI-процеси (edge, демо): ті самі змінні, та сама схема, помилка з назвами змінних. */
  static fromEnv(source: NodeJS.ProcessEnv = process.env): ObjectStorage {
    const parsed = storageEnvSchema.safeParse(source);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      throw new Error(`сховище файлів: ${issues}`);
    }
    const options = storageOptionsFrom(parsed.data);
    if (!options) {
      throw new Error('STORAGE_BUCKET не задано. Запускай через npm-скрипт (bash scripts/with-secrets.sh dev …) або експортуй змінні STORAGE_*.');
    }
    return new ObjectStorage(options);
  }

  // ─── Presigned: делегування права на одну дію над одним ключем ───────────

  /**
   * URL на PUT одного обʼєкта. Підпис накриває метод, бакет, ключ і строк —
   * підміна ключа в URL дає 403 SignatureDoesNotMatch.
   *
   * `signableHeaders: content-type` — підпис накриває і тип. Без цього SDK
   * підписує лише `host`, і клієнт, який отримав URL на `image/png`, міг би
   * покласти під цей ключ `text/html` — сховище зберегло б той тип, що прийшов.
   */
  presignPut(key: string, contentType: string, expiresIn: number): Promise<string> {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), {
      expiresIn,
      signableHeaders: new Set(['content-type']),
    });
  }

  /** URL на одну частину multipart. Тип задано на CreateMultipartUpload, тут його немає. */
  presignPart(key: string, uploadId: string, partNumber: number, expiresIn: number): Promise<string> {
    return getSignedUrl(this.s3, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), {
      expiresIn,
    });
  }

  presignGet(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }

  // ─── Обʼєкти ──────────────────────────────────────────────────────────────

  /** HeadObject: метадані без тіла. Немає обʼєкта — undefined. */
  async head(key: string): Promise<ObjectInfo | undefined> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: head.ContentLength ?? 0,
        etag: head.ETag ?? '',
        contentType: head.ContentType,
        cacheControl: head.CacheControl,
      };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /** Перші `bytes` байтів обʼєкта — Range-запитом, не тягнучи весь файл. */
  async readHead(key: string, bytes: number): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
    return Buffer.from((await res.Body?.transformToByteArray()) ?? []);
  }

  /** Обʼєкт цілком — для кеш-шару. Немає обʼєкта — undefined. */
  async get(key: string): Promise<StoredObject | undefined> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = Buffer.from((await res.Body?.transformToByteArray()) ?? []);
      return { body, size: body.length, etag: res.ETag ?? '', contentType: res.ContentType, cacheControl: res.CacheControl };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /** Запис обʼєкта нашими креденшелами — публікація ассетів, не шлях користувача. */
  async put(key: string, body: Buffer, meta: { contentType: string; cacheControl?: string }): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: meta.contentType, CacheControl: meta.cacheControl }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  // ─── Multipart: стан завантаження живе у сховищі, а не в процесі клієнта ──

  async createMultipart(key: string, contentType: string): Promise<string> {
    const res = await this.s3.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }));
    if (!res.UploadId) throw new Error(`CreateMultipartUpload ${key}: сховище не повернуло UploadId`);
    return res.UploadId;
  }

  /**
   * Частини, які вже лежать у сховищі. ListParts віддає щонайбільше 1 000 за
   * виклик, а частин буває до 10 000 — тому сторінками, до кінця.
   */
  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    for (;;) {
      const page = await this.s3.send(
        new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
      );
      for (const part of page.Parts ?? []) {
        if (part.PartNumber === undefined || part.ETag === undefined) continue;
        parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size ?? 0 });
      }
      if (!page.IsTruncated) return parts;
      marker = page.NextPartNumberMarker;
    }
  }

  /** Склеїти частини в обʼєкт. До цього моменту HeadObject на ключ — 404. */
  async completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  /** Скасувати незавершене завантаження. Вже скасоване чи завершене — не помилка. */
  async abortMultipart(key: string, uploadId: string): Promise<void> {
    try {
      await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  // ─── Бакет ────────────────────────────────────────────────────────────────

  /**
   * Бакет, якщо його ще немає. Новий бакет приватний: жодної bucket policy,
   * анонімний GET — 403. Публічно обʼєкти читає лише кеш-шар, своїми ключами.
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      // 409: BucketAlreadyOwnedByYou / BucketAlreadyExists. Чужий бакет із цим
      // імʼям на AWS теж дасть 409 — і перший же PUT покаже 403.
      if (!(err instanceof S3ServiceException && err.$metadata.httpStatusCode === 409)) throw err;
    }
    await this.ensureAbortIncompleteRule();
  }

  /**
   * Мінімальна гігієна бакета, куди заливають multipart: незавершене
   * завантаження тарифікується, хоча обʼєкта немає і в листингу його не
   * видно. Правило «видаляти старше N днів» таких хвостів не чіпає — потрібна
   * окрема дія AbortIncompleteMultipartUpload.
   *
   * Лише якщо в бакета ще немає жодної lifecycle-конфігурації:
   * PutBucketLifecycleConfiguration замінює її ЦІЛКОМ, і чужі правила
   * (наприклад, Glacier для дампів #15) зникли б мовчки.
   */
  private async ensureAbortIncompleteRule(): Promise<void> {
    try {
      await this.s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }));
      return;
    } catch (err) {
      // NoSuchLifecycleConfiguration — 404: правил немає, можна ставити.
      if (!isNotFound(err)) throw err;
    }
    await this.s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'abort-incomplete-multipart',
              Status: 'Enabled',
              Filter: { Prefix: 'uploads/' },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_INCOMPLETE_AFTER_DAYS },
            },
          ],
        },
      }),
    );
  }

  /** Скільки днів живе незавершене завантаження за правилом бакета; правила немає — undefined. */
  async abortIncompleteAfterDays(): Promise<number | undefined> {
    try {
      const config = await this.s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }));
      return config.Rules?.find((rule) => rule.Status === 'Enabled' && rule.AbortIncompleteMultipartUpload)?.AbortIncompleteMultipartUpload
        ?.DaysAfterInitiation;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /**
   * Адреса обʼєкта «повз кеш» — так його бачив би анонімний клієнт. Для
   * емулятора path-style, для AWS — virtual-hosted-style.
   */
  directUrl(key: string): string {
    const path = key.split('/').map(encodeURIComponent).join('/');
    if (this.endpoint) return `${this.endpoint.replace(/\/$/, '')}/${this.bucket}/${path}`;
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${path}`;
  }

  /** Свій endpoint — локальний емулятор або R2; порожній — AWS S3. */
  get emulated(): boolean {
    return Boolean(this.endpoint);
  }

  destroy(): void {
    this.s3.destroy();
  }
}
