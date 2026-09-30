import 'reflect-metadata';
import * as path from 'node:path';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { entities } from './entities';

/**
 * DataSource для CLI дата-шару: міграції, seed, демо N+1, звіт.
 *
 * Жодного значення тут не зашито й жоден env-файл тут не читається: усі DB_*
 * кладе в process.env обгортка `scripts/with-secrets.sh` (див. npm-скрипти),
 * яка бере їх зі сховища ДЗ #11. Немає змінної — процес падає одразу з назвою
 * змінної, а не через 30 секунд із «connection refused» до localhost.
 *
 * Схему змінюють ТІЛЬКИ міграції. Увімкнена синхронізація порівнювала б
 * entities з базою на кожному старті й мовчки робила б DROP COLUMN разом із
 * даними, щойно поле зникло з класу.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} не задано. Запускай через npm-скрипт (bash scripts/with-secrets.sh dev …) або експортуй DB_* вручну.`);
  }
  return value;
}

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: required('DB_HOST'),
  port: Number(process.env.DB_PORT ?? 5432),
  // pg називає це `user`, TypeORM — `username`. Переплутати = «password authentication failed».
  username: required('DB_USER'),
  password: required('DB_PASSWORD'),
  database: required('DB_NAME'),
  entities,
  // CLI читає скомпільований dist/data-source.js, тож і міграції беремо з dist/.
  migrations: [path.join(__dirname, 'migrations', '*.js')],
  migrationsTableName: 'migrations',
  synchronize: false,
};

// CLI (`typeorm -d dist/data-source.js`) вимагає, щоб файл експортував рівно
// один екземпляр DataSource.
export default new DataSource(dataSourceOptions);
