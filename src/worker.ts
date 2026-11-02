import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { cliDbConfig, requiredEnv } from './db/cli-env';
import { JOBS_QUEUE, openJobsQueue, upsertCleanupScheduler, type JobData } from './jobs/jobs';
import { jobProcessor } from './jobs/processor';
import { untilReady } from './redis/redis-connections';

/**
 * Воркер черги BullMQ (#23) — окремий процес, як споживач RabbitMQ: його
 * масштабують і зупиняють незалежно від API.
 *
 *   npm run worker    ≡ bash scripts/with-secrets.sh dev node dist/worker.js
 *
 * На старті — upsert планувальника прибирання. Рестарт воркера чи другий
 * інстанс викликають це знову, і планувальник лишається один.
 */
const CONCURRENCY = 5;

const log = (line: string) => console.log(`[worker ${process.pid}] ${line}`);

async function main(): Promise<void> {
  const url = requiredEnv('REDIS_QUEUE_URL');
  const db = new Pool({ ...cliDbConfig(), max: CONCURRENCY });

  // Продюсер (upsert планувальника) — дефолтні повтори ioredis, падає швидко.
  const producer = new Redis(url, { connectionName: 'marketplace-worker:queue' });
  await untilReady(producer);
  const queue = openJobsQueue(producer);
  await upsertCleanupScheduler(queue);

  // Воркеру — maxRetriesPerRequest: null. З дефолтом (20) ioredis після обриву
  // кидає MaxRetriesPerRequestError у блокуючу команду, і воркер помирає,
  // замість того щоб дочекатись Redis. Воркер нікого не обслуговує наживо,
  // тож чекати — правильно.
  const connection = new Redis(url, { maxRetriesPerRequest: null, connectionName: 'marketplace-worker:blocking' });
  const worker = new Worker<JobData, unknown>(JOBS_QUEUE, jobProcessor(db), { connection, concurrency: CONCURRENCY });

  worker.on('completed', (job, result) => log(`${job.name} ${job.id}: виконано за ${job.attemptsMade} спроб → ${JSON.stringify(result)}`));
  worker.on('failed', (job, err) => {
    const left = job ? (job.opts.attempts ?? 1) - job.attemptsMade : 0;
    log(`${job?.name ?? '?'} ${job?.id ?? '?'}: ${err.message}${left > 0 ? ` — ще спроб: ${left}` : ' — спроби вичерпано, задача у failed'}`);
  });
  worker.on('error', (err) => log(`воркер: ${err.message}`));
  log(`слухаю ${JOBS_QUEUE}, concurrency=${CONCURRENCY}`);

  // SIGTERM: Worker.close() чекає, поки доробляться задачі в роботі, і не бере
  // нових. Задача, яку обірвав SIGKILL, BullMQ поверне в чергу як stalled.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: доробляю поточні задачі`);
    await worker.close();
    await queue.close();
    await Promise.all([connection.quit(), producer.quit()]).catch(() => undefined);
    await db.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(`[worker ${process.pid}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
