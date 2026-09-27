import { performance } from 'node:perf_hooks';
import dataSource from './data-source';
import { handlers, JOB_WORK_MS } from './queue/handlers';
import { runWorker } from './queue/worker';

/**
 * Воркер-пул на SKIP LOCKED: WORKERS воркерів (Promise-и в одному процесі,
 * кожен зі своїм з'єднанням пулу) розбирають таблицю jobs.
 *
 * Черга перед стартом: JOBS демо-задач + усе, що вже pending (чеки від
 * demo:race). Одна демо-задача падає на першій спробі — вона має повернутись
 * у чергу й бути виконаною рівно один раз з другої.
 *
 * Друкує розподіл задач по воркерах, кількість оброблених двічі й час, і сам
 * перевіряє: двічі — 0, жодна задача не загубилась, працювало ≥ 2 воркери,
 * час менший за послідовний (N × JOB_WORK_MS).
 */
const WORKERS = 4;
const JOBS = 40;
const FAIL_ONCE_N = 7;

async function main() {
  await dataSource.initialize();
  try {
    const batch: { id: string }[] = await dataSource.query(
      `INSERT INTO jobs (kind, payload)
       SELECT 'demo', jsonb_build_object('n', g, 'failOnce', g = $2)
         FROM generate_series(1, $1) AS g
       RETURNING id`,
      [JOBS, FAIL_ONCE_N],
    );
    const [{ pending }] = await dataSource.query(`SELECT count(*)::int AS pending FROM jobs WHERE status = 'pending'`);
    console.log(
      `── demo:workers: ${WORKERS} воркери, у черзі ${pending} задач ` +
        `(${JOBS} демо + ${pending - JOBS} чеків від checkout), одна задача ≈ ${JOB_WORK_MS} мс ──`,
    );

    const started = performance.now();
    const stats = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) => runWorker(dataSource, { name: `worker-${i + 1}`, handlers })),
    );
    const elapsedMs = Math.round(performance.now() - started);

    const doneIds = stats.flatMap((s) => s.done);
    const processed = doneIds.length;
    const sequentialMs = processed * JOB_WORK_MS;

    // Лічильник processed читаємо з бази, а не з пам'яті воркерів: подвійну
    // обробку видно саме там, куди обидва воркери закомітили б свій +1.
    const [check] = await dataSource.query(
      `SELECT count(*) FILTER (WHERE processed > 1)::int                             AS twice,
              count(*) FILTER (WHERE id = ANY($2::bigint[]) AND (status <> 'done' OR processed <> 1))::int AS lost,
              count(*) FILTER (WHERE id = ANY($2::bigint[]) AND attempts > 1)::int  AS retried
         FROM jobs
        WHERE id = ANY($1::bigint[]) OR id = ANY($2::bigint[])`,
      [doneIds, batch.map((b) => b.id)],
    );
    const byWorker: { processed_by: string; jobs: number }[] = await dataSource.query(
      `SELECT processed_by, count(*)::int AS jobs FROM jobs WHERE id = ANY($1::bigint[]) GROUP BY 1 ORDER BY 1`,
      [doneIds],
    );

    console.log('розподіл по воркерах:');
    for (const row of byWorker) console.log(`  ${row.processed_by}: ${row.jobs}`);
    console.log(`оброблено всього: ${processed}`);
    console.log(`оброблено двічі: ${check.twice}`);
    console.log(`загублено (не done або processed ≠ 1): ${check.lost}`);
    console.log(`виконано з другої спроби після збою: ${check.retried}`);
    console.log(`час: ${elapsedMs} мс (послідовно було б ${processed} × ${JOB_WORK_MS} = ${sequentialMs} мс)`);

    const activeWorkers = byWorker.filter((w) => w.jobs > 0).length;
    const invariants: [string, boolean][] = [
      ['жодна задача не оброблена двічі', check.twice === 0],
      ['жодна задача не загубилась', check.lost === 0],
      [`задачі розподілились по ≥ 2 воркерах (${activeWorkers})`, activeWorkers >= 2],
      ['задача зі збоєм виконана після повтору', check.retried === 1],
      ['паралельно швидше за послідовно', elapsedMs < sequentialMs],
    ];
    for (const [name, ok] of invariants) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (invariants.some(([, ok]) => !ok)) process.exitCode = 1;
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
