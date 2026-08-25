/**
 * Ключі метаданих і прикладні токени.
 *
 * Скрізь `Symbol.for()`, а не `Symbol()`. Різниця критична:
 * `Symbol('x') !== Symbol('x')` — це два різні символи, а
 * `Symbol.for('x') === Symbol.for('x')` — один і той самий, бо `for` кладе
 * символ у глобальний реєстр рантайму. Через звичайний `Symbol()` метадану,
 * записану в одному модулі, не знайшли б з іншого.
 */

// ── Ключі, під якими метадату пишемо МИ ────────────────────────────────────

/** Наліпка «цей клас створює контейнер» + його скоуп. Ставить @Injectable(). */
export const INJECTABLE = Symbol.for('mini-nest:injectable');

/** Мапа «індекс параметра → явний токен». Ставить @Inject(token). */
export const INJECT_TOKENS = Symbol.for('mini-nest:inject-tokens');

// ── Ключ, під яким метадату пише КОМПІЛЯТОР ────────────────────────────────

/**
 * Рядок, а не символ — так його визначив TypeScript, і ми на це не впливаємо.
 * Зʼявляється на класі лише за двох умов одночасно: увімкнено
 * emitDecoratorMetadata І на класі висить хоча б один декоратор.
 */
export const DESIGN_PARAMTYPES = 'design:paramtypes';

// ── Прикладні токени ───────────────────────────────────────────────────────

/**
 * Приклад токена для залежності, яку неможливо вказати типом параметра.
 * Саме його чекає acceptance criteria: «залежність зареєстрована під
 * Symbol.for('CONFIG') і резолвиться саме за токеном, а не за типом».
 */
export const CONFIG = Symbol.for('CONFIG');

// ── Ключі частини 2: HTTP-шар ──────────────────────────────────────────────

/** Префікс шляху контролера. Ставить @Controller(prefix) — на КЛАСІ. */
export const CONTROLLER_PREFIX = Symbol.for('mini-nest:controller-prefix');

/**
 * Маршрут одного хендлера: { method, path }. Ставлять @Get / @Post.
 *
 * Пишеться на пару (prototype, imʼя методу) — саме так у Reflect працює
 * метадата методу. Тому шукати маршрути треба не на класі, а обходом
 * `Object.getOwnPropertyNames(Ctor.prototype)`.
 */
export const ROUTE = Symbol.for('mini-nest:route');

/**
 * Мапа «індекс аргументу → звідки брати значення». Ставлять @Body/@Param/@Query.
 *
 * Та сама механіка, що в INJECT_TOKENS, з однією відмінністю: там мапа лежала
 * на КЛАСІ (бо декорували параметри конструктора), тут — на МЕТОДІ.
 */
export const PARAMS = Symbol.for('mini-nest:params');

// ── Ключі частини 3: життєвий цикл ─────────────────────────────────────────

/** Масив класів guard'ів. Ставить @UseGuards() — на класі АБО на методі. */
export const GUARDS = Symbol.for('mini-nest:guards');

/** Масив класів interceptor'ів. Ставить @UseInterceptors(). */
export const INTERCEPTORS = Symbol.for('mini-nest:interceptors');
