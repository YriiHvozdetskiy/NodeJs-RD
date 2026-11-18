import type { Queryable } from '../db/queryable';
import { FAULTS, requestContext, type Fault } from './request-context';

/**
 * Керована відмова (#29) — щоб демо могли отримати справжній 5xx і справжній
 * повільний запит на робочому маршруті, не ламаючи базу для всіх.
 *
 * Два замки, і обидва мають бути відчинені:
 *   1. FAULT_INJECTION=1 у конфігу процесу — вмикають лише демо (src/demo-obs-pod.ts);
 *      у проді й у `npm run start` змінна порожня, і заголовок ігнорується;
 *   2. заголовок `X-Fault: error | slow` у конкретному запиті.
 *
 * Відмова — не `throw` у коді, а запит до Postgres, що справді падає або
 * справді спить. Тому 500 приходить тим самим шляхом, що й у житті: помилка
 * драйвера pg → фільтр problem+json → спан бази зі статусом ERROR → серверний
 * спан зі статусом ERROR.
 */
const FAULT_SQL: Record<Fault, string> = {
  // SQLSTATE 22012 division_by_zero — виконання падає на боці бази.
  error: 'SELECT 1/0 AS fault',
  // Повільна база: найгірший випадок, який мають покривати бакети гістограми.
  slow: 'SELECT pg_sleep(1.2) AS fault',
};

/** Розібрати заголовок `X-Fault`; невідоме значення — без відмови. */
export function parseFault(header: unknown): Fault | undefined {
  return FAULTS.find((fault) => fault === header);
}

/** Точка відмови в репозиторії: без замовленої відмови — нічого. */
export async function faultPoint(db: Queryable): Promise<void> {
  const fault = requestContext()?.fault;
  if (fault) await db.query(FAULT_SQL[fault]);
}
