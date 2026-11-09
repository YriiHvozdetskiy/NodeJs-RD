/**
 * Контракт сховища для розгортання (#28).
 *
 * Значення приходять у процес Pulumi через ту саму обгортку, що з #11:
 * `bash scripts/with-secrets.sh kind …` (npm run up). У грейдера сховища немає —
 * там SKIP_VAULT=1, і ті самі імена приходять `export`-ом.
 *
 * Два списки, бо «немає значення» буває двох видів:
 *   REQUIRED    — без них застосунок не стартує (src/config/env.schema.ts):
 *                 порожньо чи відсутньо — розгортання падає й називає змінну;
 *   SWITCHABLE  — фічі, які застосунок уміє вимикати (брокер, кеш, файли,
 *                 overlap-ротація ключа). Порожній рядок — свідоме «вимкнено».
 *                 Відсутня змінна — зламаний експорт сховища, і це теж падіння:
 *                 інакше друкарська помилка в обгортці мовчки вимикала б фічу в проді.
 *
 * Дефолтів тут немає жодного. `?? "changeme"` перетворив би «забули пароль»
 * на «задеплоїли з відомим паролем».
 */

export const REQUIRED = [
  'DB_URL',
  'DB_PASSWORD',
  'REDIS_QUEUE_URL',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'JWT_KID',
  'REFRESH_TOKEN_PEPPER',
] as const;

export const SWITCHABLE = [
  'BROKER_URL',
  'REDIS_CACHE_URL',
  'JWT_PREVIOUS_PUBLIC_KEY',
  'JWT_PREVIOUS_KID',
  'STORAGE_ENDPOINT',
  'STORAGE_BUCKET',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
] as const;

export interface Vault {
  /**
   * Оточення застосунку зі сховища: усі REQUIRED, крім DB_PASSWORD, і лише
   * ввімкнені (непорожні) SWITCHABLE. Їде в K8s Secret і в под — через envFrom.
   */
  appEnv: Record<string, string>;
  /** Пароль БД іде окремо: застосунок читає його з файла (DB_PASSWORD_FILE, #11). */
  dbPassword: string;
  db: { user: string; host: string; port: number; database: string };
  redis: { host: string; port: number; password: string };
}

/**
 * Перша дія програми — до будь-якого ресурсу і до звернення в кластер. Якщо
 * першим піде провайдер, впаде він (немає контексту, кластер лежить), і
 * змінну ніхто не назве. Помилки збираються всі одразу, як у env.schema.ts.
 */
export function readVault(env: NodeJS.ProcessEnv): Vault {
  const problems: string[] = [];

  for (const name of REQUIRED) {
    if (!env[name]) problems.push(`${name}: не задано — без неї застосунок не стартує`);
  }
  for (const name of SWITCHABLE) {
    if (env[name] === undefined) {
      problems.push(`${name}: не задано — порожній рядок вимикає фічу, відсутність означає зламаний експорт сховища`);
    }
  }

  const db = parseDbUrl(env.DB_URL, problems);
  const redis = parseRedisUrl(env.REDIS_QUEUE_URL, problems);
  const dbPassword = env.DB_PASSWORD;

  if (problems.length > 0 || !db || !redis || !dbPassword) {
    throw new Error(
      `Конфіг розгортання неповний (${problems.length}):\n` +
        problems.map((p) => `  ${p}`).join('\n') +
        '\n\nЗначення дає сховище: npm run up (bash scripts/with-secrets.sh kind …). ' +
        'Без сховища — SKIP_VAULT=1 і export за README, розділ Grading.',
    );
  }

  const appEnv: Record<string, string> = {};
  for (const name of [...REQUIRED, ...SWITCHABLE]) {
    const value = env[name];
    if (name !== 'DB_PASSWORD' && value) appEnv[name] = value;
  }
  return { appEnv, dbPassword, db, redis };
}

/** postgres://user@host:port/db — без пароля: пароль окремо, DB_PASSWORD. */
function parseDbUrl(raw: string | undefined, problems: string[]): Vault['db'] | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push('DB_URL: не URL, очікується postgres://user@host:port/db');
    return undefined;
  }
  if (url.protocol !== 'postgres:') problems.push(`DB_URL: схема ${url.protocol}, очікується postgres:`);
  if (url.password) problems.push('DB_URL: містить пароль — пароль іде окремо, у DB_PASSWORD');
  if (!url.username) problems.push('DB_URL: немає користувача');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) problems.push('DB_URL: немає імені бази');
  return { user: decodeURIComponent(url.username), host: url.hostname, port: Number(url.port || 5432), database };
}

/**
 * redis://user:password@host:port — пароль усередині URL. Без нього застосунок
 * пішов би читати REDIS_PASSWORD_FILE, якого в поді немає.
 */
function parseRedisUrl(raw: string | undefined, problems: string[]): Vault['redis'] | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push('REDIS_QUEUE_URL: не URL, очікується redis://default:password@host:port');
    return undefined;
  }
  if (url.protocol !== 'redis:') problems.push(`REDIS_QUEUE_URL: схема ${url.protocol}, очікується redis:`);
  if (!url.password) problems.push('REDIS_QUEUE_URL: немає пароля в URL');
  return { host: url.hostname, port: Number(url.port || 6379), password: decodeURIComponent(url.password) };
}
