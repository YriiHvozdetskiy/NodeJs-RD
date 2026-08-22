/**
 * Конструктор будь-якого класу.
 *
 * `any[]`, а не `unknown[]` — свідомий виняток із правила «уникати any».
 * Перевірено на TS 6.0.3: з `unknown[]` жоден реальний клас не присвоюється
 * до цього типу, бо параметри конструктора перевіряються контраваріантно —
 * `Type 'unknown' is not assignable to type 'Logger'`. Тобто контейнер не зміг би
 * навіть покласти клас у Map. Це та сама причина, з якої Nest визначає свій
 * `Type<T>` рівно так само.
 *
 * Втрати типобезпеки тут немає: у момент, коли контейнер тримає посилання на
 * клас, він і не повинен знати його сигнатуру — саме її він піде читати
 * з `design:paramtypes`.
 */
export type Constructor<T = unknown> = new (...args: any[]) => T;

/**
 * Ключ, під яким провайдер лежить у контейнері.
 *
 * Клас може бути власним ключем: у нього є комірка памʼяті, на нього є
 * посилання, тому він придатний як ключ `Map` (key === value).
 * Інтерфейс — не може: у рантаймі його не існує, посилатися нема на що.
 * Звідси другий і третій варіанти — штучний symbol або рядок.
 */
export type Token<T = unknown> = Constructor<T> | symbol | string;

/**
 * singleton — один екземпляр на контейнер (дефолт).
 * transient — новий екземпляр на кожен resolve.
 */
export type Scope = 'singleton' | 'transient';

/**
 * Відкладене посилання на токен.
 *
 * Потрібне через TDZ: у циклі з двох класів хтось обовʼязково посилається на
 * той, що оголошений нижче. Компілятор емітить `design:paramtypes` ОДРАЗУ після
 * оголошення класу, тож пряме посилання падає з
 * `ReferenceError: Cannot access 'B' before initialization` ще на завантаженні
 * модуля — до того, як контейнер узагалі щось робить.
 *
 * Тунк відкладає обчислення до `resolve`, коли обидва класи вже існують.
 * Це рівно те, чим у NestJS є `forwardRef()`.
 */
export interface ForwardRef<T = unknown> {
  readonly forwardRef: () => Token<T>;
}

/** Те, що приймає @Inject: готовий токен або відкладений. */
export type MaybeForwardRef<T = unknown> = Token<T> | ForwardRef<T>;

export interface InjectableOptions {
  scope?: Scope;
}

// ── Частина 2: HTTP-шар ────────────────────────────────────────────────────

/** Обмежуємось тим, що вимагає ДЗ. Розширюється додаванням декоратора в methods.ts. */
export type HttpMethod = 'GET' | 'POST';

/** Те, що @Get/@Post кладуть у метадані методу. Шлях тут ще БЕЗ префікса. */
export interface RouteMetadata {
  method: HttpMethod;
  path: string;
}

/** Звідки диспетчер бере значення для аргументу. */
export type ParamSource = 'body' | 'param' | 'query';

/**
 * Опис одного аргументу хендлера.
 * `name` порожнє для @Body() — тіло віддається цілком.
 */
export interface ParamMetadata {
  source: ParamSource;
  name?: string;
}

/**
 * Розріджена мапа: ключі є лише там, де стоїть декоратор.
 * Аргумент без декоратора отримає `undefined` — це не помилка, а вибір хендлера.
 */
export type ParamMap = Record<number, ParamMetadata>;

/**
 * Один рядок таблиці маршрутів — те, що router збирає з метаданих
 * і чим користується dispatcher. Тут шлях уже ПОВНИЙ, із префіксом.
 */
export interface Route {
  method: HttpMethod;
  /** Повний шаблон: `/users/:id`. Потрібен для помилок і дебагу. */
  path: string;
  /** Той самий шлях, розрізаний на сегменти — щоб не різати його на кожен запит. */
  segments: string[];
  /** Клас контролера. Екземпляр дістається з контейнера, а не створюється тут. */
  controller: Constructor;
  /** Імʼя методу на прототипі. */
  handlerName: string;
  /** Мапа аргументів цього хендлера. */
  params: ParamMap;
  /** Типи параметрів хендлера з design:paramtypes — потрібні пайпу для DTO. */
  paramTypes: Constructor[];
}
