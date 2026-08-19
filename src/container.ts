import 'reflect-metadata';

import { unwrapToken } from './forward-ref';
import { DESIGN_PARAMTYPES, INJECT_TOKENS, INJECTABLE } from './tokens';
import type { Constructor, MaybeForwardRef, Scope, Token } from './types';

/**
 * Людське імʼя токена для повідомлень про помилки.
 * Клас має `.name`; symbol і рядок доводиться приводити явно —
 * `String(Symbol.for('CONFIG'))` дає `'Symbol(CONFIG)'`.
 */
function tokenName(token: Token): string {
  return typeof token === 'function' ? token.name : String(token);
}

/**
 * Ланцюг резолву як рядок: `Top -> Mid -> Symbol(MISSING_DEP)`.
 *
 * Потрібен КОЖНІЙ помилці резолву, а не лише циклу: без нього в графі
 * Top → Mid → Deep видно тільки останній токен, і незрозуміло, хто його просив.
 */
function formatPath(path: Token[], token: Token): string {
  return [...path, token].map(tokenName).join(' -> ');
}

/**
 * Помилка циклічної залежності.
 *
 * Окремий клас, а не голий Error, з двох причин: тест має відрізнити її від
 * RangeError, і ланцюг корисно мати машиночитним, а не тільки в тексті.
 */
export class CircularDependencyError extends Error {
  constructor(public readonly chain: string[]) {
    super(`Circular dependency detected: ${chain.join(' -> ')}`);
    this.name = 'CircularDependencyError';
  }
}

export class Container {
  /** Кеш синглтонів: токен → уже створений екземпляр. */
  private readonly instances = new Map<Token, unknown>();

  /** useValue: токен → готове значення, яке віддається як є. */
  private readonly providers = new Map<Token, unknown>();

  /** useClass: токен → клас, який контейнер створить сам. */
  private readonly classProviders = new Map<Token, Constructor>();

  /**
   * Кладе готове значення під токеном (аналог `useValue` у Nest).
   *
   * Єдиний шлях, яким у контейнер потрапляє те, що не є класом: конфіг,
   * рядок підключення, фейк у тесті. Значення віддається БЕЗ копіювання —
   * усі споживачі отримають той самий обʼєкт.
   */
  register<T>(token: Token<T>, value: T): void {
    this.providers.set(token, value);
  }

  /**
   * Прив'язує токен до класу (аналог `useClass` у Nest).
   *
   * Потрібно там, де споживач залежить від інтерфейсу, а реалізацію обирають
   * зовні: `@Inject(USER_REPO)` у сервісі, `registerClass(USER_REPO, PgUserRepo)`
   * у складанні застосунку. У тесті той самий токен вказує на фейк, і сам сервіс
   * не змінюється. Контролери Лекції 7 будуть спиратися саме на це.
   *
   * Токен працює як АЛІАС: скоуп і залежності беруться з `@Injectable()` на
   * класі, а синглтон кешується під класом — тож `resolve(token)` і
   * `resolve(Class)` віддадуть один і той самий екземпляр.
   */
  registerClass<T>(token: Token<T>, target: Constructor<T>): void {
    this.classProviders.set(token, target);
  }

  /**
   * Віддає екземпляр за токеном, створюючи його та весь його граф залежностей.
   *
   * `path` тут навмисно ВІДСУТНІЙ: він деталь реалізації рекурсії, і в публічній
   * сигнатурі дозволяв би `resolve(Foo, [Foo])` — фальшивий цикл `Foo -> Foo`
   * на цілком здоровому графі. Рекурсія живе в приватному `resolveNode`.
   */
  resolve<T>(token: Token<T>): T {
    return this.resolveNode(token, []);
  }

  /**
   * Рекурсивний резолв одного вузла графа.
   *
   * @param token Клас, symbol або рядок, за яким шукати провайдера.
   * @param path Шлях від кореня до поточного вузла. Копіюється на кожну гілку
   *   і потрібен для двох речей: побачити, що ми заходимо в токен, який уже
   *   в дорозі (цикл), і назвати ланцюг у будь-якій помилці резолву.
   *
   * Порядок кроків і чому саме такий:
   *   1. цикл — перед усім іншим: у path лежить лише те, що ЗАРАЗ будується,
   *      тож із кешем (там лише добудоване) перетнутися не може, а заходити
   *      в рекурсію вже пізно — саме там виріс би RangeError;
   *   2. useValue — готове значення, ні створювати, ні розбирати не треба;
   *   3. useClass — токен як аліас на клас;
   *   4. далі можливий лише клас;
   *   5. кеш синглтонів;
   *   6. наліпка INJECTABLE — вона ж дає скоуп;
   *   7. DESIGN_PARAMTYPES + INJECT_TOKENS → список токенів залежностей;
   *   8. рекурсія з подовженим path;
   *   9. new Target(...deps) і запис у кеш, якщо singleton.
   */
  private resolveNode<T>(token: Token<T>, path: Token[]): T {
    if (path.includes(token)) {
      throw new CircularDependencyError([...path, token].map(tokenName));
    }

    // `has`, а не `get() !== undefined`: під токеном можуть свідомо лежати
    // undefined або null, і це валідне значення, а не «немає запису».
    if (this.providers.has(token)) {
      // Контейнер за своєю природою стирає типи (Map<Token, unknown>)
      // і відновлює їх на межі — assertion саме тут і саме тому.
      return this.providers.get(token) as T;
    }

    const aliased = this.classProviders.get(token);
    if (aliased !== undefined) {
      // Токен додається в path: цикл, що йде ЧЕРЕЗ аліас, теж має ловитися,
      // і в ланцюгу видно, через який саме токен прийшли.
      // Map<Token, Constructor> не зберігає T — та сама межа стирання типів.
      return this.resolveNode(aliased, [...path, token]) as T;
    }

    // Далі створювати можна тільки клас. `typeof === 'function'` відсікає
    // symbol і string, і TypeScript після цього сам звужує тип до Constructor.
    // Ця перевірка мусить бути ДО будь-якого читання метаданих: Reflect
    // очікує обʼєкт як ціль, і на symbol впав би з TypeError.
    if (typeof token !== 'function') {
      throw new Error(
        `Не можу створити залежність за токеном ${tokenName(token)}: це не клас, ` +
          'і його не зареєстровано ні через register(), ні через registerClass(). ' +
          `Шлях резолву: ${formatPath(path, token)}`,
      );
    }

    // Кеш. Стоїть ДО читання скоупу навмисно: у instances потрапляють лише
    // синглтони, тож сам факт наявності вже є відповіддю. Зайвого читання
    // метаданих на попаданні не робимо.
    if (this.instances.has(token)) {
      return this.instances.get(token) as T;
    }

    // Наліпка. getOwnMetadata, а не getMetadata: інакше нащадок без власного
    // @Injectable() успадкував би і наліпку, і — головне — чужий
    // design:paramtypes, і контейнер зібрав би його з аргументами батька.
    const scope: Scope | undefined = Reflect.getOwnMetadata(INJECTABLE, token);
    if (scope === undefined) {
      throw new Error(
        `${token.name} не позначений @Injectable(). Без декоратора компілятор ` +
          'не емітить design:paramtypes, тож контейнер не знає, з чого його збирати. ' +
          `Шлях резолву: ${formatPath(path, token)}`,
      );
    }

    // Типи параметрів конструктора. getOwnMetadata оголошений як any, тож
    // анотації змінної достатньо — type assertion не потрібен.
    // undefined тут — не помилка, а клас без параметрів конструктора.
    const paramTypes: Constructor[] | undefined = Reflect.getOwnMetadata(DESIGN_PARAMTYPES, token);

    // Явні токени з @Inject. Розріджена мапа: ключі є лише там, де декоратор стоїть.
    const injected: Record<number, MaybeForwardRef> = Reflect.getOwnMetadata(INJECT_TOKENS, token) ?? {};

    // Рекурсія + накладання. Ітеруємо саме по paramTypes, бо його довжина
    // дорівнює арності конструктора; мапа лише ПЕРЕКРИВАЄ окремі позиції.
    // Будувати список з мапи не можна — зʼїхала б кількість аргументів.
    //
    // `injected[i] ?? type` — токен виграє в типу.
    // `[...path, token]` — новий масив на кожну гілку: спільний мутабельний
    // path зіпсував би сусідні гілки.
    // Умова виходу з рекурсії окремо не потрібна: клас без залежностей дає
    // undefined → `?? []` → .map ні разу не викликається → доходимо до new.
    // unwrapToken розгортає forwardRef(() => B) у сам B — саме тут, а не в
    // декораторі: у момент декорування B ще не існує.
    const deps = (paramTypes ?? []).map((type, index) =>
      this.resolveNode(unwrapToken(injected[index] ?? type), [...path, token]),
    );

    const instance = new token(...deps);

    // У кеш — тільки singleton. transient сюди не потрапляє ніколи, тому
    // перевірка на вході (`instances.has`) для нього завжди дасть false.
    if (scope === 'singleton') {
      this.instances.set(token, instance);
    }

    return instance;
  }
}
