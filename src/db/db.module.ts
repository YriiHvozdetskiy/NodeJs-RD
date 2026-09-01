import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

/**
 * `@Global`, бо доступ до БД потрібен усюди, а перекладати `DbModule` в
 * `imports` кожного майбутнього модуля — шум без користі. На #13 сюди
 * приїде `TypeOrmModule.forRootAsync`, і `DatabaseService` або стане
 * обгорткою над `DataSource`, або зникне разом із сирим `pg`.
 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DbModule {}
