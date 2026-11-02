import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import { cliDbConfig } from './db/cli-env';
import {
  CLEANUP_SCHEDULER_ID,
  enqueueOrderWebhook,
  JOB,
  JOB_DEFAULTS,
  JOBS_QUEUE,
  openJobsQueue,
  upsertCleanupScheduler,
  type JobData,
  type JobsQueue,
} from './jobs/jobs';
import { jobProcessor } from './jobs/processor';
import { Summary, waitFor } from './messaging/demo-kit';
import { configGet, keysWithPrefix, migrateSchema, openRedis } from './redis/demo-kit';

/**
 * demo:queue — пункти 5 і 6 ДЗ #23 на справжніх JOB_DEFAULTS і jobProcessor:
 *
 *   1. queue-noeviction — CONFIG GET maxmemory-policy зі зʼєднання черги;
 *   2. дедуп: два add вебхука того самого замовлення (як дві доставки
 *      order.placed із RabbitMQ) → у черзі одна задача;
 *   3. retry: партнер-заглушка двічі відповідає 503, потім 200 → задача
 *      виконалась тричі й завершилась, паузи між спробами — експонента з jitter;
 *   4. планувальник: upsert двічі (як два рестарти воркера) → він один,
 *      і за вікно спостереження встигає спрацювати кілька разів.
 *
 * Черга — та сама `marketplace-jobs`, але під власним prefix цього прогону:
 * робочий воркер (npm run worker) цих задач не побачить, а наприкінці демо
 * видаляє все своє. Планувальник тут кожну секунду, у воркері — щогодини.
 */
const SCHEDULER_EVERY_MS = 1_000;
const MIN_SCHEDULED_RUNS = 3;
const FAILURES_BEFORE_SUCCESS = 2;

interface Hit {
  at: number;
  eventId: string | undefined;
}

async function main(): Promise<void> {
  const summary = new Summary();
  const prefix = `bull-demo-${process.pid}-${Date.now().toString(36)}`;
  await migrateSchema();
  const pool = new Pool({ ...cliDbConfig(), max: 5 });
  const admin = await openRedis('REDIS_QUEUE_URL', 'demo-queue:admin');
  const producer = await openRedis('REDIS_QUEUE_URL', 'demo-queue:producer');
  // Воркеру — maxRetriesPerRequest: null, як у src/worker.ts.
  const blocking = await openRedis('REDIS_QUEUE_URL', 'demo-queue:worker', { maxRetriesPerRequest: null });
  const partner = await startPartner(FAILURES_BEFORE_SUCCESS);
  const queue = openJobsQueue(producer, prefix);
  let worker: Worker<JobData, unknown> | undefined;

  try {
    const policy = await configGet(admin, 'maxmemory-policy');
    console.log(`── demo:queue: інстанс черги maxmemory-policy ${policy}; prefix ${prefix} ──`);

    // ── 2. дедуп за jobId — воркера ще немає, задачі лежать у черзі ──────────
    const data = { eventId: randomUUID(), orderId: String(900_000_000 + Math.floor(Math.random() * 1_000_000)), url: partner.url };
    const first = await enqueueOrderWebhook(queue, data);
    const second = await enqueueOrderWebhook(queue, data);
    const added = 2;
    const queued = await queue.count();
    console.log(`add ×${added} з jobId ${first.id} → у черзі ${queued}`);

    // ── 4. планувальник: upsert двічі ─────────────────────────────────────────
    await upsertCleanupScheduler(queue, SCHEDULER_EVERY_MS);
    await upsertCleanupScheduler(queue, SCHEDULER_EVERY_MS);
    const schedulers = await queue.getJobSchedulersCount();

    // ── 3. воркер із робочим обробником ───────────────────────────────────────
    let scheduledRuns = 0;
    let webhookDone = false;
    worker = new Worker<JobData, unknown>(JOBS_QUEUE, jobProcessor(pool), { connection: blocking, prefix, concurrency: 5 });
    worker.on('completed', (job) => {
      if (job.name === JOB.cleanup) scheduledRuns += 1;
      if (job.id === first.id) webhookDone = true;
    });
    worker.on('failed', (job, err) => {
      if (job && job.id === first.id) console.log(`спроба ${job.attemptsMade}: ${err.message} — повтор за backoff`);
    });
    await waitFor(
      `вебхук виконано і планувальник спрацював ${MIN_SCHEDULED_RUNS} рази`,
      async () => webhookDone && scheduledRuns >= MIN_SCHEDULED_RUNS,
      30_000,
    );
    await worker.close();
    worker = undefined;

    const job = await queue.getJob(String(first.id));
    const completedWebhooks = (await queue.getCompleted()).filter((j) => j.name === JOB.orderWebhook).length;
    const gaps = partner.hits.slice(1).map((hit, i) => hit.at - partner.hits[i].at);
    const sameEvent = partner.hits.every((hit) => hit.eventId === data.eventId);
    gaps.forEach((gap, i) => console.log(`пауза перед спробою ${i + 2}: ${gap} мс (exponential, delay ${backoffDelay()} мс, jitter)`));

    summary.line('queue-noeviction', policy === 'noeviction' ? 1 : 0);
    summary.line('added', added);
    summary.line('queued', queued);
    summary.line('same-job', first.id === second.id ? 1 : 0);
    summary.line('attempts', partner.hits.length);
    summary.line('attempts-made', job?.attemptsMade ?? 0);
    summary.line('completed', completedWebhooks);
    summary.line('same-event-id', sameEvent ? 1 : 0);
    gaps.forEach((gap, i) => summary.line(`backoff-${i + 1}-ms`, gap));
    summary.line('schedulers', schedulers);
    summary.line('scheduled-runs', scheduledRuns);

    summary.expect('queue-noeviction=1 — черга на інстансі без витіснення', policy === 'noeviction');
    summary.expect('queued=1 — два add з тим самим jobId дали одну задачу', queued === 1 && first.id === second.id);
    summary.expect(`attempts=${FAILURES_BEFORE_SUCCESS + 1} — ${FAILURES_BEFORE_SUCCESS} невдачі й успіх`, partner.hits.length === FAILURES_BEFORE_SUCCESS + 1);
    summary.expect('completed=1', completedWebhooks === 1);
    summary.expect('schedulers=1 — upsert не плодить дублікатів', schedulers === 1);
    summary.expect(`scheduled-runs ≥ ${MIN_SCHEDULED_RUNS}`, scheduledRuns >= MIN_SCHEDULED_RUNS);
  } finally {
    await worker?.close();
    await cleanup(queue, admin, prefix);
    await Promise.all([admin, producer, blocking].map((redis) => redis.quit().catch(() => undefined)));
    await partner.close();
    await pool.end();
  }
  summary.finish();
}

function backoffDelay(): number {
  const backoff = JOB_DEFAULTS.backoff;
  return typeof backoff === 'object' ? (backoff.delay ?? 0) : (backoff ?? 0);
}

/** Самоочищення: планувальник, усі задачі й ключі цього prefix. */
async function cleanup(queue: JobsQueue, admin: Redis, prefix: string): Promise<void> {
  await queue.removeJobScheduler(CLEANUP_SCHEDULER_ID).catch(() => undefined);
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  const leftovers = await keysWithPrefix(admin, `${prefix}:`);
  if (leftovers.length > 0) await admin.del(...leftovers);
}

interface Partner {
  url: string;
  hits: Hit[];
  close(): Promise<void>;
}

/**
 * Партнер-заглушка: перші `failures` запитів — 503, далі 200. Падіння задачі
 * тут не вигадане в обробнику, а приходить ззовні — як у проді.
 */
async function startPartner(failures: number): Promise<Partner> {
  const hits: Hit[] = [];
  const server: Server = createServer((req, res) => {
    const eventId = req.headers['x-event-id'];
    hits.push({ at: Date.now(), eventId: typeof eventId === 'string' ? eventId : undefined });
    req.resume();
    res.statusCode = hits.length <= failures ? 503 : 200;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhooks/orders`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
