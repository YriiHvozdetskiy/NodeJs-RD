import { z } from 'zod';

/**
 * ЄДИНЕ джерело правди про конфігурацію сервісу.
 *
 * З цього об'єкта виводяться три різні речі, і саме тому він один:
 *   1. рантайм-перевірка на старті (`validate` нижче);
 *   2. TypeScript-тип `Env` — його бачить `ConfigService<Env, true>`;
 *   3. список ключів для `scripts/check-env-example.mjs`, який не дає
 *      `.env.example` відстати від схеми.
 *
 * Все, що приходить з оточення, — РЯДОК. Тому числа беруться через
 * `z.coerce.number()`, а не `z.number()`: `z.number()` на "3000" впаде.
 *
 * Секретів тут немає навмисно. Пароль до Postgres у схему не входить —
 * він живе у файлі (`DB_PASSWORD_FILE`), бо env замерзає на старті процесу,
 * а файл можна перечитати на кожне нове з'єднання. Див. `src/db/database.service.ts`.
 */
export const envSchema = z.object({
  /** Режим роботи. Впливає на детальність помилок і на те, що ставить npm у образі. */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Порт HTTP-сервера. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /** Рівень логування. Поки читається лише на старті — логер приїде пізніше. */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Куди підключатись до Postgres — БЕЗ пароля: `postgres://user@host:port/db`.
   * Обов'язкова: сервіс без адреси БД стартувати не має права.
   */
  DB_URL: z.url({ protocol: /^postgres$/ }),

  /** Шлях до файла з паролем БД. Відносний — від кореня репозиторію. */
  DB_PASSWORD_FILE: z.string().min(1).default('./secrets/db_password'),

  /** Скільки з'єднань тримає пул. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * DRIFT=1 — демо з ДЗ#9: обробник навмисно віддає `totalCents` замість
   * `total_cents`, щоб було видно, як валідатор відповідей ловить дрейф.
   * `.transform` перетворює рядок оточення на `boolean` рівно один раз — тут.
   */
  DRIFT: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),

  /**
   * Штучна затримка в обробнику `POST /orders`, мс. Теж із ДЗ#9: без вікна,
   * у якому обробник віддає event loop, гілка 409 `in-flight` недосяжна.
   */
  SLOW_MS: z.coerce.number().int().min(0).default(0),
});

export type Env = z.infer<typeof envSchema>;

/**
 * `ConfigModule.forRoot({ validate })` викликає це РІВНО ОДИН РАЗ і ДО того,
 * як Nest почне будувати DI-граф. Кинутий звідси `Error` означає: жоден
 * провайдер не створився, порт не відкрився, процес вийшов із кодом ≠ 0.
 *
 * Помилки збираються всі одразу. Інакше виправлення конфігу перетворюється на
 * цикл «запустив — впало на одній змінній — виправив — впало на наступній».
 */
export function validate(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const lines = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(
    `Невалідна конфігурація середовища:\n${lines}\n\n` +
      'Повний список змінних із коментарями — у .env.example (`cp .env.example .env`).',
  );
}
