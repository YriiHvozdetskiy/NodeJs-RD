import 'reflect-metadata';
import * as path from 'node:path';
import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { cliDbConfig } from './db/cli-env';
import { entities } from './entities';

/**
 * DataSource для CLI дата-шару: міграції, seed, демо N+1, звіт.
 *
 * Жодного значення тут не зашито й жоден env-файл тут не читається: усі DB_*
 * кладе в process.env обгортка `scripts/with-secrets.sh` (див. npm-скрипти),
 * яка бере їх зі сховища ДЗ #11. Читає їх `cliDbConfig()` — той самий, що й у
 * споживача брокера (#19).
 *
 * Схему змінюють ТІЛЬКИ міграції. Увімкнена синхронізація порівнювала б
 * entities з базою на кожному старті й мовчки робила б DROP COLUMN разом із
 * даними, щойно поле зникло з класу.
 */
const db = cliDbConfig();

// Тип саме Postgres, а не загальний DataSourceOptions: демо #14 розширюють
// опції полями драйвера (poolSize), яких у союзі всіх драйверів немає.
export const dataSourceOptions: PostgresConnectionOptions = {
  type: 'postgres',
  host: db.host,
  port: db.port,
  // pg називає це `user`, TypeORM — `username`. Переплутати = «password authentication failed».
  username: db.user,
  password: db.password,
  database: db.database,
  entities,
  // CLI читає скомпільований dist/data-source.js, тож і міграції беремо з dist/.
  migrations: [path.join(__dirname, 'migrations', '*.js')],
  migrationsTableName: 'migrations',
  synchronize: false,
};

// CLI (`typeorm -d dist/data-source.js`) вимагає, щоб файл експортував рівно
// один екземпляр DataSource.
export default new DataSource(dataSourceOptions);
