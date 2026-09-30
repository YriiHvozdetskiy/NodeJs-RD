import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Pool } from 'pg';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { entities } from '../../src/entities';

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  /** Пул для arrange- і assert-фаз: тест ходить у базу напряму, повз застосунок. */
  pool: Pool;
  /** Оточення, з яким застосунок підключиться саме до цього контейнера. */
  appEnv(): Promise<Record<string, string>>;
  stop(): Promise<void>;
}

/**
 * Справжній Postgres у Docker на один тестовий файл, зі схемою, яку дали
 * міграції, а не рукописний DDL: тест бачить ті самі constraint-и, індекси й
 * CHECK-и, що й прод. Порт хоста — ефемерний, його обирає testcontainers;
 * контейнер прибирає ryuk навіть тоді, коли jest упав посеред файла.
 */
export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('marketplace').start();
  const uri = container.getConnectionUri();
  await migrate(uri);

  const pool = new Pool({ connectionString: uri, max: 4 });
  let secretsDir: string | undefined;

  return {
    container,
    pool,

    async appEnv() {
      // Застосунок підключається тим самим каналом, що й у проді (#11): адреса
      // в DB_URL без пароля, пароль — файлом. Адресу видає сам контейнер, тож
      // жодного DATABASE_URL у сховищі тестам не треба.
      secretsDir ??= await mkdtemp(path.join(os.tmpdir(), 'marketplace-pg-'));
      const passwordFile = path.join(secretsDir, 'db_password');
      await writeFile(passwordFile, container.getPassword(), { mode: 0o600 });

      const url = new URL(uri);
      url.password = '';

      return {
        NODE_ENV: 'test',
        DB_URL: url.toString(),
        DB_PASSWORD_FILE: passwordFile,
        DB_POOL_MAX: '4',
        // Явно, бо ConfigModule читає й локальний .env: DRIFT=1 звідти зламав би
        // кожну перевірку форми відповіді.
        DRIFT: '0',
        SLOW_MS: '0',
        // Порожній рядок = брокера немає. Без цього рядка локальний .env дав би
        // застосунку в тестах справжній RabbitMQ, і кожне POST /orders лишало б
        // order.placed у черзі дев-споживача.
        BROKER_URL: '',
      };
    },

    async stop() {
      await pool.end();
      await container.stop();
      if (secretsDir) await rm(secretsDir, { recursive: true, force: true });
    },
  };
}

/**
 * Ті самі міграції, що `npm run migrate`, лише зі скомпільованого
 * dist-test/src/migrations. entities потрібні не для запитів, а для
 * `typeorm_metadata`: InitSchema пише туди вираз генерованої колонки, і
 * таблицю TypeORM створює лише тоді, коли бачить entity з такою колонкою.
 */
async function migrate(uri: string): Promise<void> {
  const dataSource = new DataSource({
    type: 'postgres',
    url: uri,
    entities,
    migrations: [path.join(__dirname, '..', '..', 'src', 'migrations', '*.js')],
    migrationsTableName: 'migrations',
  });
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}
