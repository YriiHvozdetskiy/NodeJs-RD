import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { OrmService } from './orm.service';
import { DB } from './queryable';

/**
 * `@Global`, бо доступ до БД потрібен усюди, а перекладати `DbModule` в
 * `imports` кожного модуля — шум без користі.
 *
 * Два пули з однаковими параметрами (src/db/connection.ts):
 *   • `DatabaseService` — сирий `pg`, під токеном `DB` його отримують
 *     репозиторії як `Queryable`;
 *   • `OrmService` — `DataSource` TypeORM для транзакції `checkout()` з #14.
 * `src/data-source.ts` живе окремо й обслуговує CLI: міграції, seed, демо.
 */
@Global()
@Module({
  providers: [DatabaseService, OrmService, { provide: DB, useExisting: DatabaseService }],
  exports: [DatabaseService, OrmService, DB],
})
export class DbModule {}
