import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

/**
 * `@Global`, бо доступ до БД потрібен усюди, а перекладати `DbModule` в
 * `imports` кожного майбутнього модуля — шум без користі. ORM-шар #13
 * живе поза DI: `src/data-source.ts` обслуговує міграції, seed і звіти з CLI.
 * `TypeOrmModule.forRootAsync` приїде сюди разом із транзакційною логікою #14,
 * і тоді `DatabaseService` або стане обгорткою над `DataSource`, або зникне
 * разом із сирим `pg`.
 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DbModule {}
