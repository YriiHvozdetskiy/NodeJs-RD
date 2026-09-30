import type { EntityManager } from 'typeorm';

/**
 * Сирий SQL усередині транзакції TypeORM з однаковою формою результату.
 *
 * Пастка, через яку цей хелпер існує: `manager.query()` для SELECT та INSERT
 * повертає масив рядків, а для UPDATE та DELETE — пару `[rows, rowCount]`.
 * На `UPDATE … RETURNING` це означає, що «0 рядків = товару нема» мовчки
 * перетворюється на `result.length === 2`, і перевірка stock завжди проходить.
 * Структурований результат queryRunner'а однаковий для всіх команд.
 *
 * Приймає лише manager транзакції: `dataSource.manager` не має власного
 * queryRunner'а, і кожен його запит міг би поїхати в інше з'єднання пулу.
 */
export async function sql<T>(manager: EntityManager, text: string, params: unknown[] = []): Promise<T[]> {
  const runner = manager.queryRunner;
  if (!runner) {
    throw new Error('sql(): потрібен manager транзакції — виклик усередині dataSource.transaction(...)');
  }
  const result = await runner.query(text, params, true);
  return result.records;
}

/**
 * Postgres SQLSTATE, які checkout розрізняє явно. Повний перелік — Appendix A
 * документації. Коди, які варто повторювати, живуть окремо — у src/db/retry.ts.
 */
export const PG_ERROR = {
  FOREIGN_KEY_VIOLATION: '23503',
} as const;

/**
 * Поле помилки Postgres (`code`, `constraint`) незалежно від того, хто її
 * кинув: `pg` кладе поля на саму помилку, TypeORM загортає її в
 * QueryFailedError і тримає оригінал у `driverError`.
 */
export function pgErrorField(err: unknown, field: 'code' | 'constraint'): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const own: unknown = Reflect.get(err, field);
  if (typeof own === 'string') return own;
  return pgErrorField(Reflect.get(err, 'driverError'), field);
}
