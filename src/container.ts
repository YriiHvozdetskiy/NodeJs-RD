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

  /** Явні реєстрації: токен → готове значення. */
  private readonly providers = new Map<Token, unknown>();

  /**
   * Кладе готове значення під токеном.
   *
   * Це єдиний шлях, яким у контейнер потрапляє те, що не є класом: конфіг,
   * рядок підключення, фейк у тесті. Клас реєструвати не обовʼязково —
   * контейнер уміє створити його сам, прочитавши метадані.
   */
  register<T>(token: Token<T>, value: T): void {
    this.providers.set(token, value);
  }

  /**
   * Віддає екземпляр за токеном, створюючи його та весь його граф залежностей.
   *
   * @param token Клас, symbol або рядок, за яким шукати провайдера.
   * @param path Шлях резолву від кореня до поточного вузла. Передається
   *   рекурсивно і потрібен рівно для одного: побачити, що ми заходимо в клас,
   *   який уже є в дорозі, і кинути CircularDependencyError з повним ланцюгом —
   *   замість RangeError на десяти тисячах кадрів стека.
   *
   * Порядок кроків, який має вийти:
   *   1. явна реєстрація в providers — віддати як є, це не клас;
   *   2. цикл — токен уже в path;
   *   3. кеш синглтонів;
   *   4. наліпка INJECTABLE — якщо її немає, це не наш провайдер;
   *   5. DESIGN_PARAMTYPES + INJECT_TOKENS → список токенів залежностей;
   *   6. рекурсивний resolve кожної з них із подовженим path;
   *   7. new Target(...deps), і покласти в кеш, якщо скоуп singleton.
   */
  resolve<T>(token: Token<T>, path: Token[] = []): T {
    // Крок 1 — явна реєстрація. Стоїть найпершою: зареєстроване значення
    // не треба ні створювати, ні перевіряти на цикл, і саме сюди приходять
    // symbol-токени, які нижче не пройшли б перевірку на клас.
    // `has`, а не `get() !== undefined`: під токеном можуть свідомо лежати
    // undefined або null, і це валідне значення, а не «немає запису».
    if (this.providers.has(token)) {
      return this.providers.get(token) as T;
    }

    // Крок 2 — цикл. Стоїть ДО кешу, ДО читання метаданих і ДО рекурсії:
    // у `path` лежить лише те, що ЗАРАЗ будується, тож перетнутися з кешем
    // (там лише добудоване) воно не може, а от у рекурсію заходити вже пізно —
    // саме там і виріс би RangeError на десяти тисячах кадрів.
    if (path.includes(token)) {
      throw new CircularDependencyError([...path, token].map(tokenName));
    }

    // Далі створювати можна тільки клас. `typeof === 'function'` відсікає
    // symbol і string, і TypeScript після цього сам звужує тип до Constructor.
    // Ця перевірка мусить бути ДО будь-якого читання метаданих: Reflect
    // очікує обʼєкт як ціль, і на symbol впав би з TypeError.
    if (typeof token !== 'function') {
      throw new Error(
        `Не можу створити залежність за токеном ${String(token)}: ` +
          'це не клас, і його не зареєстровано через register().',
      );
    }

    // Крок 3 — кеш. Стоїть ДО читання скоупу навмисно: у instances потрапляють
    // лише синглтони, тож сам факт наявності вже є відповіддю. Зайвого читання
    // метаданих на попаданні не робимо.
    if (this.instances.has(token)) {
      // Єдиний type assertion у файлі. Контейнер за своєю природою стирає
      // типи (Map<Token, unknown>) і відновлює їх на межі — рівно тут.
      return this.instances.get(token) as T;
    }

    // Крок 4 — наліпка. getOwnMetadata, а не getMetadata: інакше нащадок без
    // власного @Injectable() успадкував би і наліпку, і — головне — чужий
    // design:paramtypes, і контейнер зібрав би його з аргументами батька.
    const scope: Scope | undefined = Reflect.getOwnMetadata(INJECTABLE, token);
    if (scope === undefined) {
      throw new Error(
        `${token.name} не позначений @Injectable(). ` +
          'Без декоратора компілятор не емітить design:paramtypes, ' +
          'тож контейнер не знає, з чого його збирати.',
      );
    }

    // Типи параметрів конструктора. getOwnMetadata оголошений як any, тож
    // анотації змінної достатньо — type assertion не потрібен.
    // undefined тут — не помилка, а клас без параметрів конструктора.
    const paramTypes: Constructor[] | undefined = Reflect.getOwnMetadata(DESIGN_PARAMTYPES, token);

    // Крок 5б — явні токени з @Inject. Розріджена мапа: ключі є лише там,
    // де декоратор стоїть.
    const injected: Record<number, MaybeForwardRef> = Reflect.getOwnMetadata(INJECT_TOKENS, token) ?? {};

    // Рекурсія + накладання. Ітеруємо саме по paramTypes, бо його довжина
    // дорівнює арності конструктора; мапа лише ПЕРЕКРИВАЄ окремі позиції.
    // Будувати список з мапи не можна — зʼїхала б кількість аргументів.
    //
    // `injected[i] ?? type` — токен виграє в типу. Це і є вимога AC#7:
    // «резолвиться саме за токеном, а не за типом».
    //
    // `[...path, token]` — новий масив на кожну гілку: спільний мутабельний
    // path зіпсував би сусідні гілки. Нічого це поки не читає, але шлях уже
    // правильно протягнутий під крок 2.
    //
    // Умова виходу з рекурсії окремо не потрібна: клас без залежностей дає
    // undefined → `?? []` → .map ні разу не викликається → доходимо до new.
    // unwrapToken розгортає forwardRef(() => B) у сам B. Робимо це ТУТ, а не
    // в декораторі: у момент декорування B ще не існує — у цьому весь сенс тунка.
    const deps = (paramTypes ?? []).map((type, index) =>
      this.resolve(unwrapToken(injected[index] ?? type), [...path, token]),
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
