import { Queue, type DefaultJobOptions, type Job } from 'bullmq';
import type Redis from 'ioredis';

/**
 * Одна черга BullMQ на роботу, якій не місце в HTTP-запиті (#23):
 *   order-webhook — сповістити партнера про order.placed (повільний чужий HTTP);
 *   cleanup       — раз на годину прибрати прострочені рядки outbox, inbox
 *                   споживача й ключів ідемпотентності (план із #22).
 *
 * Черга — у Redis-інстансі з noeviction. На allkeys-lru Redis під тиском
 * памʼяті витіснив би ключі черги, і задача зникла б мовчки — BullMQ сам
 * попереджає про це в лозі (`IMPORTANT! Eviction policy is …`).
 *
 * Це менеджер задач, а не брокер: набір failed — не DLQ у сенсі #19, а
 * архів задач, що вичерпали спроби.
 */
export const JOBS_QUEUE = 'marketplace-jobs';

export const JOB = {
  orderWebhook: 'order-webhook',
  cleanup: 'cleanup',
} as const;

export interface OrderWebhookData {
  eventId: string;
  orderId: string;
  url: string;
}

export type CleanupData = Record<string, never>;

export type JobData = OrderWebhookData | CleanupData;

/**
 * Імʼя задачі — дефолтний `string`, а не union із JOB: BullMQ типізує тим
 * самим параметром і id планувальника (upsertJobScheduler), а той — не імʼя задачі.
 */
export type JobsQueue = Queue<JobData, unknown>;

export type MarketplaceJob = Job<JobData, unknown>;

const DAY_S = 24 * 60 * 60;

/**
 * attempts: 5 — до пʼяти виконань. backoff: exponential із jitter — паузи
 * 1 с, 2 с, 4 с, 8 с, кожна зрізана випадково до половини: delay × 2^(n-1) ×
 * (1 - jitter × random). Без jitter сотня задач, що впали від одного збою
 * партнера, повторювалась би одночасно й дала б йому ту саму хвилю ще раз —
 * той самий jitter, що в retry з #22.
 *
 * removeOnComplete: { age } — а не `true`. Дедуп за jobId працює, лише доки
 * задача з цим id існує: видалена одразу задача — і повторний add того самого
 * jobId створить її вдруге (так написано в документації BullMQ). 7 днів — із
 * запасом довше за вікно, в якому RabbitMQ може передоставити order.placed.
 * count — стеля, щоб пік замовлень не тримав у Redis мільйон виконаних задач.
 */
export const JOB_DEFAULTS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000, jitter: 0.5 },
  removeOnComplete: { age: 7 * DAY_S, count: 100_000 },
  removeOnFail: { age: 30 * DAY_S },
};

/**
 * Продюсер. Клієнт — fail-fast (дефолтні повтори ioredis): той, хто кладе
 * задачу, має дізнатися про недоступний Redis одразу, а не висіти.
 * `prefix` — простір імен ключів; демо бере власний, щоб не зачепити робочу чергу.
 */
export function openJobsQueue(connection: Redis, prefix?: string): JobsQueue {
  return new Queue<JobData, unknown>(JOBS_QUEUE, { connection, prefix, defaultJobOptions: JOB_DEFAULTS });
}

/**
 * jobId з id замовлення — дедуп. order.placed приходить із RabbitMQ
 * at-least-once: relay, що впав між publish і позначкою, чи споживач, що впав
 * між ефектом і ack, дадуть другу доставку. Другий add з тим самим jobId
 * повертає вже наявну задачу й нової не створює. Двокрапки в jobId BullMQ
 * забороняє (це його роздільник ключів), тому дефіс.
 */
export function orderWebhookJobId(orderId: string): string {
  return `order-webhook-${orderId}`;
}

export function enqueueOrderWebhook(queue: JobsQueue, data: OrderWebhookData): Promise<MarketplaceJob> {
  return queue.add(JOB.orderWebhook, data, { jobId: orderWebhookJobId(data.orderId) });
}

export const CLEANUP_SCHEDULER_ID = 'cleanup-expired-rows';
const HOUR_MS = 60 * 60 * 1000;

/**
 * upsert, а не add з repeat: кожен рестарт воркера викликає це заново, і
 * upsert з тим самим id оновлює наявний планувальник замість створити
 * другий. (repeat і getRepeatableJobs у BullMQ 6 прибрано.)
 *
 * Наступну задачу планувальник створює, лише коли попередня пішла в роботу,
 * тож паралельних прибирань не буде навіть на кількох воркерах.
 */
export function upsertCleanupScheduler(queue: JobsQueue, everyMs = HOUR_MS): Promise<MarketplaceJob> {
  return queue.upsertJobScheduler(
    CLEANUP_SCHEDULER_ID,
    { every: everyMs },
    {
      name: JOB.cleanup,
      data: {},
      opts: { attempts: 3, backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 }, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
    },
  );
}
