import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpProblem } from '../common/http-problem';
import type { Env } from '../config/env.schema';
import { ObjectStorage, storageOptionsFrom } from './object-storage';

/**
 * Сховище файлів усередині застосунку. Без STORAGE_BUCKET застосунок
 * стартує — і відповідає 503 на маршрутах файлів, назвавши змінну. Так
 * ходять тести #16, яким сховище ні до чого, і так само поводиться брокер.
 */
@Injectable()
export class FileStorage implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly storage?: ObjectStorage;
  private readonly logger = new Logger(FileStorage.name);

  constructor(config: ConfigService<Env, true>) {
    const options = storageOptionsFrom({
      STORAGE_ENDPOINT: config.get('STORAGE_ENDPOINT', { infer: true }),
      STORAGE_REGION: config.get('STORAGE_REGION', { infer: true }),
      STORAGE_BUCKET: config.get('STORAGE_BUCKET', { infer: true }),
      STORAGE_ACCESS_KEY: config.get('STORAGE_ACCESS_KEY', { infer: true }),
      STORAGE_SECRET_KEY: config.get('STORAGE_SECRET_KEY', { infer: true }),
    });
    this.storage = options && new ObjectStorage(options);
  }

  get(): ObjectStorage {
    if (!this.storage) {
      throw new HttpProblem(503, 'сховище файлів не налаштоване: потрібні STORAGE_BUCKET і ключі сховища', 'service-unavailable');
    }
    return this.storage;
  }

  /**
   * Бакет на локальному емуляторі створює сам застосунок: свіжий том RustFS
   * порожній, а грейдер не запускає жодного init-кроку. На AWS бакет — частина
   * інфраструктури (IaC), і в ролі застосунку немає права s3:CreateBucket,
   * тож там цього кроку немає. Помилка тут не валить старт: без сховища
   * падають лише маршрути файлів.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.storage?.emulated) return;
    try {
      await this.storage.ensureBucket();
    } catch (err) {
      this.logger.warn(`бакет ${this.storage.bucket}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onModuleDestroy(): void {
    this.storage?.destroy();
  }
}
