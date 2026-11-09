import { createPrivateKey, createPublicKey } from 'node:crypto';
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

  /**
   * Куди вбудований relay outbox (#22) виносить події домену — БЕЗ пароля, як
   * і DB_URL: `amqp://user@host:port`. Пароль — файлом із BROKER_PASSWORD_FILE.
   *
   * Опціональна свідомо. Подію checkout пише в outbox своєю транзакцією, і
   * брокер для цього не потрібен: без BROKER_URL relay не стартує, а події
   * чекають у таблиці, доки їх не винесе `npm run relay`. Так ходять тести.
   * Порожній рядок дорівнює відсутності — ним тести й вимикають брокер поверх
   * локального .env.
   */
  BROKER_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url({ protocol: /^amqps?$/ }).optional()),

  /** Файл із паролем брокера. Відносний — від кореня репозиторію. */
  BROKER_PASSWORD_FILE: z.string().min(1).default('./secrets/rabbitmq_password'),

  /**
   * Redis під кеш (#23) — БЕЗ пароля, як DB_URL: `redis://default@host:port`.
   * Інстанс із maxmemory + allkeys-lru: там лише копія даних із Postgres.
   *
   * Опціональна з тієї ж причини, що BROKER_URL: без неї GET товару просто
   * щоразу йде в базу. Порожній рядок дорівнює відсутності — так тести
   * вимикають Redis поверх локального .env.
   */
  REDIS_CACHE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url({ protocol: /^rediss?$/ }).optional()),

  /**
   * Redis під чергу BullMQ, сесії, вікна rate-limit (#23) і денилист
   * access-токенів (#24) — БЕЗ пароля. Інстанс із noeviction + AOF: тут
   * лежить те, що не можна губити мовчки.
   *
   * У схемі опційна, бо сесії й ліміт без неї просто вимкнені, а тести
   * ходять без Redis. Але застосунок без неї не стартує: денилист
   * (src/auth/access-denylist.ts) падає на збиранні DI з назвою цієї змінної —
   * логаут без денилиста не відкликав би access-токени.
   */
  REDIS_QUEUE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url({ protocol: /^rediss?$/ }).optional()),

  /** Файл із паролем обох Redis. Відносний — від кореня репозиторію. */
  REDIS_PASSWORD_FILE: z.string().min(1).default('./secrets/redis_password'),

  /**
   * S3 API сховища файлів (#26): `http://127.0.0.1:22650` для RustFS із compose.
   * Порожньо — справжній AWS S3: SDK сам збудує адресу з регіону й бакета.
   * Адреса — не секрет, тому тут, а не в сховищі.
   */
  STORAGE_ENDPOINT: z.preprocess((v) => (v === '' ? undefined : v), z.url({ protocol: /^https?$/ }).optional()),

  /** Регіон підпису SigV4. Емулятору байдуже, AWS — ні: підпис містить регіон. */
  STORAGE_REGION: z.string().min(1).default('us-east-1'),

  /**
   * Бакет файлів. Один на все: `uploads/` — приватні завантаження користувачів,
   * `assets/` — публічні ассети, які роздає лише кеш-шар (src/edge.ts).
   *
   * Опційний з тієї ж причини, що BROKER_URL: без нього застосунок стартує, а
   * маршрути файлів відповідають 503 з назвою змінної. Так ходять тести.
   */
  STORAGE_BUCKET: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'імʼя бакета S3: 3–63 символи з [a-z0-9.-]')
      .optional(),
  ),

  /**
   * З яких origin браузер може ходити в API, слухати SSE і підключати socket.io:
   * `http://localhost:5173,https://shop.example`. Порожньо — лише той самий
   * origin. Кожен елемент — саме origin (схема + хост + порт), без шляху й
   * слеша наприкінці: браузер надсилає `Origin` рівно в такому вигляді, і
   * `https://shop.example/` з ним уже не збігся б.
   */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((raw) => raw.split(',').map((origin) => origin.trim()).filter(Boolean))
    .pipe(
      z.array(
        z.url({ protocol: /^https?$/ }).refine((origin) => new URL(origin).origin === origin, {
          message: 'потрібен origin без шляху й слеша наприкінці: http://localhost:5173',
        }),
      ),
    ),
});

/**
 * PEM у змінній оточення — base64 від цілого файла: багаторядковий PEM в
 * `export` виживає не в кожному середовищі, і розплата за це —
 * `error:1E08010C:DECODER routines::unsupported` на першому ж підписі.
 * Тут же перевіряється, що це справді ключ ES256 (EC P-256), а не будь-що, —
 * інакше помилка випливла б лише на першому логіні.
 */
function ecKey(kind: 'private' | 'public') {
  return z
    .string()
    .min(1)
    .refine(
      (b64) => {
        try {
          const pem = Buffer.from(b64, 'base64').toString('utf8');
          const key = kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
          return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
        } catch {
          return false;
        }
      },
      { message: `потрібен base64 від PEM ${kind === 'private' ? 'PKCS#8' : 'SPKI'} ключа EC P-256 (ES256)` },
    );
}

/** Ідентифікатор ключа в заголовку JWT: `dev-2026-11`, `grader`. */
const kid = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'kid: 1–64 символи з [A-Za-z0-9._-]');

/**
 * Секрети автентифікації (#24). Окремою схемою з однієї причини: вони
 * приходять ЛИШЕ зі сховища — `scripts/with-secrets.sh` кладе їх у оточення
 * процесу з `secrets/jwt/<env>/`. У `.env.example` їх немає свідомо, тому
 * `scripts/check-env-example.mjs` звіряє файл лише з `envSchema`, а цю схему
 * перевіряє протилежно: жоден ключ звідси не має права зʼявитись у `.env.example`.
 *
 * Жодного `.default()` тут немає і бути не може: дефолт ключа підпису — це
 * ключ, зашитий у код, тобто будь-хто з доступом до репозиторію виписує собі
 * токен будь-кого. Голий `npm run start` без обгортки падає тут, назвавши
 * змінні, — до першого зʼєднання з базою.
 */
export const vaultSchema = z.object({
  /** Приватний ключ підпису access-токенів. Ним володіє лише видавець — цей сервіс. */
  JWT_PRIVATE_KEY: ecKey('private'),
  /** Публічна половина тієї самої пари — нею перевіряється підпис. */
  JWT_PUBLIC_KEY: ecKey('public'),
  /** `kid` активної пари: іде в заголовок кожного виданого токена. */
  JWT_KID: kid,
  /**
   * Overlap-ротація: публічний ключ ПОПЕРЕДНЬОЇ пари і його `kid`. Токени,
   * підписані старим ключем до ротації, доживають свої хвилини, а нові вже
   * підписуються новим. Обидві змінні разом або жодної.
   */
  JWT_PREVIOUS_PUBLIC_KEY: z.preprocess((v) => (v === '' ? undefined : v), ecKey('public').optional()),
  JWT_PREVIOUS_KID: z.preprocess((v) => (v === '' ? undefined : v), kid.optional()),
  /**
   * «Перець» для HMAC-хешу refresh-токенів у базі. Без нього дамп таблиці
   * `refresh_tokens` нічого не дає: хеш не перевірити, не знаючи перцю.
   * Мінімум тут — лише запобіжник від порожнього чи обрізаного значення;
   * стійкість дає `npm run keys:init`, який кладе в сховище 32 випадкові байти.
   */
  REFRESH_TOKEN_PEPPER: z.string().min(8, 'щонайменше 8 символів'),
  /**
   * Ключі доступу до сховища файлів (#26) — з secrets/storage_access_key і
   * secrets/storage_secret_key. Це право читати й переписувати кожен файл у
   * бакеті, тому лише сховище і ніколи .env.
   *
   * Опційні свідомо: на AWS процес ходить у S3 під IAM-роллю, і SDK бере
   * тимчасові креденшели сам (STS, ланцюжок провайдерів за замовчуванням).
   * Довгоживуча пара ключів у проді — саме те, чого роль позбавляє.
   * Обидві змінні разом або жодної.
   */
  STORAGE_ACCESS_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(3).optional()),
  STORAGE_SECRET_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
});

/** Повна схема процесу: оточення + секрети сховища. */
const fullSchema = envSchema.extend(vaultSchema.shape).superRefine((env, ctx) => {
  // Пара, зібрана з двох різних ключів, підписувала б токени, які сам сервіс
  // не зміг би перевірити: кожен запит — 401 без жодної зрозумілої причини.
  try {
    const derived = createPublicKey(Buffer.from(env.JWT_PRIVATE_KEY, 'base64').toString('utf8'));
    const given = createPublicKey(Buffer.from(env.JWT_PUBLIC_KEY, 'base64').toString('utf8'));
    if (!derived.equals(given)) {
      ctx.addIssue({ code: 'custom', path: ['JWT_PUBLIC_KEY'], message: 'не є публічною половиною JWT_PRIVATE_KEY' });
    }
  } catch {
    // Формат кожного ключа вже перевірив свій refine вище.
  }
  if ((env.JWT_PREVIOUS_PUBLIC_KEY === undefined) !== (env.JWT_PREVIOUS_KID === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['JWT_PREVIOUS_KID'], message: 'JWT_PREVIOUS_PUBLIC_KEY і JWT_PREVIOUS_KID задаються разом' });
  }
  if ((env.STORAGE_ACCESS_KEY === undefined) !== (env.STORAGE_SECRET_KEY === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['STORAGE_SECRET_KEY'], message: 'STORAGE_ACCESS_KEY і STORAGE_SECRET_KEY задаються разом' });
  }
  if (env.JWT_PREVIOUS_KID !== undefined && env.JWT_PREVIOUS_KID === env.JWT_KID) {
    ctx.addIssue({ code: 'custom', path: ['JWT_PREVIOUS_KID'], message: 'збігається з JWT_KID — після ротації kid має бути новий' });
  }
});

export type Env = z.infer<typeof fullSchema>;

/**
 * `ConfigModule.forRoot({ validate })` викликає це РІВНО ОДИН РАЗ і ДО того,
 * як Nest почне будувати DI-граф. Кинутий звідси `Error` означає: жоден
 * провайдер не створився, порт не відкрився, процес вийшов із кодом ≠ 0.
 *
 * Помилки збираються всі одразу. Інакше виправлення конфігу перетворюється на
 * цикл «запустив — впало на одній змінній — виправив — впало на наступній».
 */
export function validate(raw: Record<string, unknown>): Env {
  const parsed = fullSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const lines = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  const vaultKeys = Object.keys(vaultSchema.shape);
  const fromVault = parsed.error.issues.some((issue) => vaultKeys.includes(String(issue.path[0])));
  throw new Error(
    `Невалідна конфігурація середовища:\n${lines}\n\n` +
      'Повний список змінних із коментарями — у .env.example (`cp .env.example .env`).' +
      (fromVault
        ? '\nКлюч підпису й перець приходять лише зі сховища, не з .env: `npm run start:vault` ' +
          '(bash scripts/with-secrets.sh dev …); ключі в сховищі створює `npm run keys:init`.'
        : ''),
  );
}
