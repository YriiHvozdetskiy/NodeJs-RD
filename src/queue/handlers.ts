import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from '../db/sql';
import type { JobHandler } from './worker';

/**
 * Скільки «коштує» одна задача. Справжнього SMTP немає (README розділ 4):
 * пауза стоїть на місці мережевого виклику, щоб час воркер-пулу було з чим
 * порівняти — послідовно N задач тривали б N × JOB_WORK_MS.
 */
export const JOB_WORK_MS = 100;

/** Чек на замовлення: те, що checkout поклав у чергу разом із замовленням. */
export const sendReceipt: JobHandler = async (manager, job) => {
  const [order] = await sql<{ id: string; total_cents: number; points_spent: number; email: string }>(
    manager,
    `SELECT o.id, o.total_cents, o.points_spent, u.email
       FROM orders o JOIN users u ON u.id = o.buyer_id
      WHERE o.id = $1`,
    [String(job.payload.orderId)],
  );
  if (!order) throw new Error(`замовлення ${String(job.payload.orderId)} не знайдено`);
  await sleep(JOB_WORK_MS);
  return { to: order.email, orderId: order.id, totalCents: order.total_cents, pointsSpent: order.points_spent };
};

/**
 * Демо-задача для demo:workers. `failOnce` імітує збій SMTP на першій спробі:
 * задача має повернутись у чергу й бути виконаною рівно один раз з другої.
 */
export const demoTask: JobHandler = async (_manager, job) => {
  await sleep(JOB_WORK_MS);
  if (job.payload.failOnce === true && job.attempts === 0) {
    throw new Error('421 SMTP service not available (імітація)');
  }
  return { n: job.payload.n, attempt: job.attempts + 1 };
};

export const handlers = { order_receipt: sendReceipt, demo: demoTask };
