/**
 * Помилка, яку кидає наш власний код (не валідатор).
 *
 * `code` — це слаг, що потрапить у `type` відповіді. Він мусить бути одним із
 * тих, що перелічені в `enum` схеми `Problem` у openapi/openapi.yaml: інакше
 * `validateResponses: true` відкине нашу ж відповідь як незадекларовану.
 */
export type ProblemCode =
  | 'validation-error'
  | 'invalid-cursor'
  | 'bad-request'
  | 'not-found'
  | 'conflict'
  | 'idempotency-key-in-flight'
  | 'unprocessable-entity'
  | 'idempotency-key-reused'
  | 'unknown-product'
  | 'internal';

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly code?: ProblemCode,
  ) {
    super(detail);
  }
}
