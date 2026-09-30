import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSource, EntityManager } from 'typeorm';
import { sql } from '../db/sql';
import type { JobKind } from '../entities/job.entity';

/**
 * Воркер черги `jobs`. Кілька воркерів розбирають одну таблицю, не
 * заважаючи одне одному й не беручи ту саму задачу двічі.
 *
 * Серце — `FOR UPDATE SKIP LOCKED`:
 *   • FOR UPDATE — рядок задачі заблоковано до кінця транзакції воркера;
 *   • SKIP LOCKED — заблоковані іншими рядки не чекаються, а пропускаються.
 * Без SKIP LOCKED усі воркери стояли б у черзі за першим рядком і працювали б
 * по одному; без FOR UPDATE двоє взяли б ту саму задачу.
 * (TypeORM QueryBuilder пише те саме як setLock('pessimistic_write') +
 * setOnLocked('skip_locked').)
 *
 * Транзакція відкрита на весь час обробки: лок і є «я цю задачу роблю».
 * Процес упав до COMMIT — Postgres відкотив транзакцію, лок зник, задача знову
 * pending і дістанеться іншому воркеру. status = done, processed + 1 і
 * result комітяться одним COMMIT разом із будь-якими записами обробника.
 *
 * Ціна підходу: одне з'єднання пулу на кожну задачу в роботі, і довгий
 * обробник тримає довгу транзакцію. Для задач на хвилини беруть «оренду»
 * (locked_until + окремий коміт на захоплення) — або брокер, як на #19.
 */

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  /** Скільки спроб було ДО цієї. */
  attempts: number;
  maxAttempts: number;
}

/** Обробник пише в БД через manager — у тій самій транзакції, що й статус задачі. */
export type JobHandler = (manager: EntityManager, job: ClaimedJob) => Promise<Record<string, unknown>>;

export interface WorkerOptions {
  name: string;
  handlers: Record<JobKind, JobHandler>;
  /** Пауза, коли вільних задач зараз нема, але черга ще не порожня. */
  idleWaitMs?: number;
  /** Пауза перед повтором задачі після збою обробника: base · 2^(спроба−1). */
  retryBaseMs?: number;
}

export interface WorkerStats {
  name: string;
  done: string[];
  failedAttempts: number;
}

interface JobRow {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

type Outcome = { status: 'empty' } | { status: 'done'; id: string } | { status: 'failed'; id: string };

export async function runWorker(dataSource: DataSource, options: WorkerOptions): Promise<WorkerStats> {
  const { name, handlers, idleWaitMs = 50, retryBaseMs = 100 } = options;
  const stats: WorkerStats = { name, done: [], failedAttempts: 0 };

  for (;;) {
    const outcome = await dataSource.transaction('READ COMMITTED', async (manager): Promise<Outcome> => {
      const [row] = await sql<JobRow>(
        manager,
        `SELECT id, kind, payload, attempts, max_attempts
           FROM jobs
          WHERE status = 'pending' AND run_at <= now()
          ORDER BY run_at, id
          LIMIT 1
            FOR UPDATE SKIP LOCKED`,
      );
      if (!row) return { status: 'empty' };

      const job: ClaimedJob = { id: row.id, kind: row.kind, payload: row.payload, attempts: row.attempts, maxAttempts: row.max_attempts };

      // Savepoint відділяє записи обробника від обліку спроби: обробник упав —
      // його записи відкочуються, а attempts + 1 і last_error комітяться, і
      // все це під тим самим локом, без вікна, у яке задачу схопив би інший.
      await sql(manager, 'SAVEPOINT job_handler');
      try {
        const result = await handlers[job.kind](manager, job);
        await sql(manager, 'RELEASE SAVEPOINT job_handler');
        await sql(
          manager,
          `UPDATE jobs
              SET status = 'done', processed = processed + 1, attempts = attempts + 1,
                  processed_by = $2, result = $3, last_error = NULL, done_at = now()
            WHERE id = $1`,
          [job.id, name, JSON.stringify(result)],
        );
        return { status: 'done', id: job.id };
      } catch (err) {
        await sql(manager, 'ROLLBACK TO SAVEPOINT job_handler');
        const attempt = job.attempts + 1;
        await sql(
          manager,
          `UPDATE jobs
              SET attempts = $2, last_error = $3,
                  status = CASE WHEN $2 >= max_attempts THEN 'failed' ELSE 'pending' END,
                  run_at = now() + make_interval(secs => $4)
            WHERE id = $1`,
          [job.id, attempt, err instanceof Error ? err.message : String(err), (retryBaseMs * 2 ** (attempt - 1)) / 1000],
        );
        console.warn(`[${name}] задача ${job.id} (${job.kind}) впала, спроба ${attempt}/${job.maxAttempts}: ${err instanceof Error ? err.message : err}`);
        return { status: 'failed', id: job.id };
      }
    });

    if (outcome.status === 'done') {
      stats.done.push(outcome.id);
      continue;
    }
    if (outcome.status === 'failed') {
      stats.failedAttempts += 1;
      continue;
    }

    // Порожній SKIP LOCKED означає «вільних немає ЗАРАЗ», а не «черга порожня»:
    // решта pending може бути заблокована іншими воркерами (і повернеться,
    // якщо той воркер упаде) або відкладена backoff'ом у run_at.
    // Звичайний SELECT без локу бачить заблоковані рядки як pending.
    const [{ pending }] = await dataSource.query(`SELECT count(*)::int AS pending FROM jobs WHERE status = 'pending'`);
    if (pending === 0) return stats;
    await sleep(idleWaitMs);
  }
}
