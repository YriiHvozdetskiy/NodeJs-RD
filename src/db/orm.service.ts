import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Env } from '../config/env.schema';
import { entities } from '../entities';
import { dbConnection } from './connection';

/**
 * TypeORM `DataSource` усередині Nest — для транзакції оформлення (#14):
 * `checkout()` відкриває її сам через `dataSource.transaction(...)`.
 *
 * Це другий пул поруч із `DatabaseService`. Читання лишаються на сирому `pg`
 * (#11), транзакція — на TypeORM (#14); за PgBouncer зайві клієнтські
 * з'єднання не коштують серверних.
 *
 * Підключення ліниве: перший `get()` відкриває пул, наступні отримують той самий
 * проміс. Застосунок стартує й віддає `/health` навіть із лежачою БД — так само,
 * як із `pg.Pool`, який теж не підключається до першого запиту.
 */
@Injectable()
export class OrmService implements OnModuleDestroy {
  private readonly dataSource: DataSource;
  private ready?: Promise<DataSource>;

  constructor(config: ConfigService<Env, true>) {
    const { host, port, database, user, password, max } = dbConnection(config);
    this.dataSource = new DataSource({
      type: 'postgres',
      host,
      port,
      database,
      // pg називає це `user`, TypeORM — `username`.
      username: user,
      // TypeORM передає функцію в pg.Pool як є — ротація пароля діє і тут.
      password,
      poolSize: max,
      entities,
      // Схему змінюють лише міграції (розділ 7 README) — і в застосунку теж.
      synchronize: false,
    });
  }

  get(): Promise<DataSource> {
    // Невдале підключення не кешується: інакше після того, як БД підніметься,
    // кожен checkout і далі отримував би ту саму давню помилку.
    this.ready ??= this.dataSource.initialize().catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  async onModuleDestroy(): Promise<void> {
    // Дочекатись підключення, що саме відкривається: `destroy()` посеред
    // `initialize()` лишив би відкритий пул, і jest не завершився б.
    await this.ready?.catch(() => undefined);
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
