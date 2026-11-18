import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Контекст запиту (#29) — те, що кожен рядок логу знає про свій запит, хоча
 * жодна функція не отримує `req` аргументом.
 *
 * AsyncLocalStorage — сховище, привʼязане не до змінної, а до ланцюжка
 * асинхронних викликів: усе, що запустилось усередині `run(store, fn)`,
 * включно з продовженнями після `await`, бачить той самий `store`. Паралельний
 * запит має власний ланцюжок і власний `store`. Тому «поточний запит» у
 * змінній модуля тут неможливий: під вісьмома паралельними запитами змінна
 * модуля містила б останній, і рядки змішались би.
 *
 * Корелятора тут немає свідомо. trace_id бере логер з активного спана OTel
 * (src/observability/logger.ts): власний uuid був би другим ключем, якого не
 * знає ні Tempo, ні клієнт, що прислав `traceparent`.
 */
export interface RequestContext {
  /** Хто робить запит — з токена; кладе AuthGuard після перевірки підпису (#24). */
  userId?: string;
  /**
   * Тенант із заголовка `X-Tenant-Id`. Маркетплейс однотенантний, тож це
   * лише мітка для пошуку в логах: авторизація її не читає ніде.
   */
  tenant?: string;
  /** Ключ `Idempotency-Key` (#22): видно, яка спроба клієнта породила рядок. */
  idempotencyKey?: string;
  /** Штучна відмова для демо (src/observability/fault.ts); без FAULT_INJECTION=1 — завжди undefined. */
  fault?: Fault;
}

export const FAULTS = ['error', 'slow'] as const;
export type Fault = (typeof FAULTS)[number];

const storage = new AsyncLocalStorage<RequestContext>();

/** Виконати `fn` у новому контексті запиту. Викликає лише перше middleware ланцюжка. */
export function runInRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Контекст поточного запиту; поза запитом (старт, фонова задача) — undefined. */
export function requestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Дописати користувача в контекст. Гард не може загорнути обробник у власний
 * `run` — він лише повертає true, — тож він змінює ТОЙ САМИЙ обʼєкт, який
 * створило перше middleware. Обробник і все нижче бачать уже з userId.
 */
export function bindUser(userId: string): void {
  const context = storage.getStore();
  if (context) context.userId = userId;
}
