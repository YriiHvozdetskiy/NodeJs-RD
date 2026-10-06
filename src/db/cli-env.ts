/**
 * Оточення CLI-процесів: міграції, seed, демо, споживач брокера (#19).
 *
 * Жоден env-файл тут не читається: значення кладе в process.env обгортка
 * `scripts/with-secrets.sh`, яка бере їх зі сховища ДЗ #11. Немає змінної —
 * процес падає одразу з її назвою, а не через 30 секунд із «connection
 * refused» до localhost.
 */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} не задано. Запускай через npm-скрипт (bash scripts/with-secrets.sh dev …) або експортуй змінну вручну.`);
  }
  return value;
}

export interface CliDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** DB_* від обгортки. Під SKIP_VAULT=1 обгортка виводить їх із DATABASE_URL. */
export function cliDbConfig(): CliDbConfig {
  return {
    host: requiredEnv('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    user: requiredEnv('DB_USER'),
    password: requiredEnv('DB_PASSWORD'),
    database: requiredEnv('DB_NAME'),
  };
}
