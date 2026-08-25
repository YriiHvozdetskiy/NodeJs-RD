/**
 * Точка спостереження за етапами циклу.
 *
 * Кожна стадія повідомляє, що вона почалась. За замовчуванням це нічого не
 * коштує — обробник порожній. Підписатись можна ззовні: тест ловить порядок,
 * а на Лекції 29 сюди стане OpenTelemetry-span.
 *
 * Це не «код заради тесту»: те, що фреймворк уміє розповісти, де зараз
 * запит, — звичайна вимога observability. Без такої точки єдиний спосіб
 * дізнатись порядок етапів — читати вихідники.
 */
export type LifecycleStage =
  | 'middleware'
  | 'guard'
  | 'interceptor:before'
  | 'pipe'
  | 'handler'
  | 'interceptor:after';

export type LifecycleTracer = (stage: LifecycleStage) => void;

let tracer: LifecycleTracer | undefined;

/** Підписатись на етапи. Повертає функцію відписки. */
export function setLifecycleTracer(next: LifecycleTracer | undefined): () => void {
  const previous = tracer;
  tracer = next;
  return () => {
    tracer = previous;
  };
}

export function traceStage(stage: LifecycleStage): void {
  tracer?.(stage);
}
