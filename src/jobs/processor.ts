import { UnrecoverableError } from 'bullmq';
import type { Queryable } from '../db/queryable';
import { JOB, type MarketplaceJob, type OrderWebhookData } from './jobs';

/** Скільки чекаємо на партнера. Завислий вебхук не має тримати слот воркера. */
const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Коди, які варто повторити: 5xx, 408 (таймаут на їхньому боці), 429 (просять
 * зачекати). Решта 4xx — помилка в самому запиті, і повтор дасть те саме.
 */
function retryable(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Вебхук партнеру. Кидання з обробника = невдала спроба: BullMQ поставить
 * задачу на повтор за backoff із JOB_DEFAULTS. `UnrecoverableError` — повтор
 * не допоможе, задача одразу в failed без решти спроб.
 *
 * `X-Event-Id` — бо доставка партнеру теж at-least-once: відповідь 200 могла
 * загубитись дорогою, і BullMQ повторить уже виконаний вебхук. Партнер
 * упізнає дубль за цим id — той самий прийом, що inbox споживача з #22.
 */
async function deliverOrderWebhook(data: OrderWebhookData): Promise<{ status: number }> {
  let res: Response;
  try {
    res = await fetch(data.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-event-id': data.eventId },
      body: JSON.stringify({ type: 'order.placed', order_id: Number(data.orderId) }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    // Мережа чи таймаут — тимчасове, повторюємо.
    throw new Error(`вебхук ${data.url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await res.body?.cancel();
  if (res.ok) return { status: res.status };
  if (retryable(res.status)) throw new Error(`вебхук ${data.url}: ${res.status}`);
  throw new UnrecoverableError(`вебхук ${data.url}: ${res.status} — повтор не допоможе`);
}

/** Скільки рядків видаляє один оператор. */
const CLEANUP_BATCH = 1_000;

/**
 * Порціями, кожна — окремий автокоміт: один DELETE на мільйон рядків тримав
 * би довгу транзакцію й роздув би WAL одним шматком. ctid, а не PK: у
 * processed_messages ключ складений, а ctid однаковий для всіх трьох таблиць.
 * Таблиця й умова — константи з коду нижче, не дані ззовні.
 */
async function deleteInBatches(db: Queryable, table: string, expired: string): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await db.query(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${expired} LIMIT ${CLEANUP_BATCH})`);
    const deleted = res.rowCount ?? 0;
    total += deleted;
    if (deleted < CLEANUP_BATCH) return total;
  }
}

/**
 * Строки зберігання — з плану #22 (README, розділ 13):
 *   outbox             7 днів після публікації — для розбору інцидентів;
 *   processed_messages 30 днів — довше за будь-яку передоставку брокера;
 *                      дубль, що прийде пізніше, зупинить природний ключ;
 *   idempotency_keys   24 години — стільки обіцяє спека для Idempotency-Key.
 * Невинесений outbox (published_at IS NULL) не чіпаємо ніколи.
 */
async function cleanupExpired(db: Queryable): Promise<Record<string, number>> {
  return {
    outbox: await deleteInBatches(db, 'outbox', `published_at < now() - interval '7 days'`),
    processed_messages: await deleteInBatches(db, 'processed_messages', `processed_at < now() - interval '30 days'`),
    idempotency_keys: await deleteInBatches(db, 'idempotency_keys', `created_at < now() - interval '24 hours'`),
  };
}

/** Обробник для Worker: одна черга, задачі розрізняються іменем. */
export function jobProcessor(db: Queryable): (job: MarketplaceJob) => Promise<unknown> {
  return async (job) => {
    switch (job.name) {
      case JOB.orderWebhook:
        return deliverOrderWebhook(orderWebhookData(job.data));
      case JOB.cleanup:
        return cleanupExpired(db);
      default:
        throw new UnrecoverableError(`невідома задача ${String(job.name)}`);
    }
  };
}

/** Дані з Redis — не довіряємо формі наосліп: битий payload не стане fetch на undefined. */
function orderWebhookData(data: unknown): OrderWebhookData {
  if (
    typeof data === 'object' &&
    data !== null &&
    'eventId' in data &&
    'orderId' in data &&
    'url' in data &&
    typeof data.eventId === 'string' &&
    typeof data.orderId === 'string' &&
    typeof data.url === 'string'
  ) {
    return { eventId: data.eventId, orderId: data.orderId, url: data.url };
  }
  throw new UnrecoverableError(`битий payload вебхука: ${JSON.stringify(data)}`);
}
