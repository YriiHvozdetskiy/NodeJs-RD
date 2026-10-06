import { setTimeout as sleep } from 'node:timers/promises';
import type { Channel } from 'amqplib';
import { managementApi, type ManagementApi } from './broker-url';

/**
 * Топологія подій домену (#19).
 *
 *   checkout ──order.placed──▶ shop.events (topic)
 *                                  │ binding order.placed
 *                                  ▼
 *                           loyalty.order.placed (quorum) ──▶ споживач балів
 *                                  │ reject(false) · delivery-limit
 *                                  ▼
 *                              shop.dlx (direct)
 *                                  │ binding loyalty.order.placed
 *                                  ▼
 *                           loyalty.order.placed.dlq (quorum)
 *
 * Оголошує це СПОЖИВАЧ (і демо як бутстрап-крок), а не продюсер. Продюсер
 * знає лише exchange і routing key: хто слухає order.placed — не його справа,
 * і новий підписник (аудит, пошук) приходить зі своєю чергою й binding, не
 * чіпаючи checkout.
 *
 * Черги quorum: класичні з 4.0 не реплікуються взагалі (ha-mode прибрано), а
 * delivery-limit — ліміт повернень, після якого повідомлення йде в DLX, —
 * існує лише в quorum.
 */
export const EVENTS_EXCHANGE = 'shop.events';
export const DEAD_LETTER_EXCHANGE = 'shop.dlx';
export const ORDER_PLACED = 'order.placed';
export const LOYALTY_QUEUE = 'loyalty.order.placed';
export const LOYALTY_DLQ = 'loyalty.order.placed.dlq';

/**
 * Скільки разів повідомлення може повернутись у чергу, перш ніж піде в DLX.
 * Стоковий дефолт quorum — 20. Повернення тут миттєві, без паузи, тож 20
 * спроб за мілісекунди нічого не дають транзієнтній помилці, крім шуму: 5
 * покриває короткий збій зʼєднання з базою, а retry з паузою — тема #22.
 *
 * Лічильник росте не лише від reject(requeue=true): на 4.2 його інкрементить
 * і nack, і обрив зʼєднання споживача з непідтвердженим повідомленням. Тобто
 * подія, що валить сам процес споживача, теж дійде до DLQ, а не крутитиметься
 * вічно в циклі «старт → падіння».
 */
export const DELIVERY_LIMIT = 5;

const QUORUM = { 'x-queue-type': 'quorum' } as const;

/**
 * DLX і ліміт — ПОЛІТИКОЮ, а не x-arguments черги. Аргументи незмінні: додати
 * DLX до вже наявної черги можна лише через її видалення (разом із
 * повідомленнями), інакше `406 PRECONDITION_FAILED - inequivalent arg`.
 * Політику брокер перезаписує на живій черзі.
 *
 * Тип черги лишається аргументом — політикою його не задати.
 */
const POLICIES = [
  {
    name: 'loyalty-order-placed-dlx',
    pattern: '^loyalty\\.order\\.placed$',
    definition: {
      'dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      // Routing key мертвого повідомлення — імʼя його робочої черги, а не
      // оригінальний order.placed. Інакше DLQ кожного майбутнього підписника
      // order.placed, привʼязана до shop.dlx тим самим ключем, отримувала б
      // копію чужих мерців.
      'dead-letter-routing-key': LOYALTY_QUEUE,
      'delivery-limit': DELIVERY_LIMIT,
    },
  },
  {
    // DLQ теж quorum, а отже теж має дефолтний delivery-limit 20 — і DLX у неї
    // немає. Кожен «Get messages → Requeue» у UI — повернення, і на 21-му
    // перегляді повідомлення мовчки зникло б. Склад доказів не має самознищуватись.
    name: 'loyalty-order-placed-dlq',
    pattern: '^loyalty\\.order\\.placed\\.dlq$',
    definition: { 'delivery-limit': -1 },
  },
] as const;

export async function assertLoyaltyTopology(ch: Channel, brokerUrl: string): Promise<void> {
  await ch.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await ch.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });

  await ch.assertQueue(LOYALTY_QUEUE, { durable: true, arguments: QUORUM });
  await ch.assertQueue(LOYALTY_DLQ, { durable: true, arguments: QUORUM });

  await ch.bindQueue(LOYALTY_QUEUE, EVENTS_EXCHANGE, ORDER_PLACED);
  await ch.bindQueue(LOYALTY_DLQ, DEAD_LETTER_EXCHANGE, LOYALTY_QUEUE);

  const api = managementApi(brokerUrl);
  for (const policy of POLICIES) {
    await request(api, 'PUT', `/policies/${api.vhost}/${policy.name}`, {
      pattern: policy.pattern,
      'apply-to': 'queues',
      priority: 10,
      definition: policy.definition,
    });
  }
  await waitForPolicy(api);
}

/**
 * PUT політики відповідає 204 одразу, а до quorum-черги вона доїжджає
 * асинхронно: на цій установці — за ~2,4 с. Споживач, що почав би читати
 * раніше, відправив би перше ж отруєне повідомлення в reject без DLX — тобто
 * в нікуди. Тому чекаємо, поки це побачить сама черга, а не ручка API.
 */
async function waitForPolicy(api: ManagementApi, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const queue = await request(api, 'GET', `/queues/${api.vhost}/${encodeURIComponent(LOYALTY_QUEUE)}`);
    const effective = isRecord(queue) && isRecord(queue.effective_policy_definition) ? queue.effective_policy_definition : {};
    if (effective['dead-letter-exchange'] === DEAD_LETTER_EXCHANGE && effective['delivery-limit'] === DELIVERY_LIMIT) return;
    if (Date.now() > deadline) {
      throw new Error(`політика DLX не доїхала до ${LOYALTY_QUEUE} за ${timeoutMs} мс: ${JSON.stringify(effective)}`);
    }
    await sleep(100);
  }
}

async function request(api: ManagementApi, method: 'GET' | 'PUT', pathname: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${api.base}${pathname}`, {
      method,
      headers: { authorization: api.authorization, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    // Сам fetch каже лише «fetch failed». Найчастіша причина — 15672 у
    // compose перемаплено на інший порт хоста: AMQP за BROKER_URL доступний,
    // а API за виведеною з нього адресою — ні, і топологія падає ще до першої
    // публікації. Тому помилка називає адресу і змінну, якою її виправити.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
    throw new Error(
      `management API недоступний за ${api.base} (${cause}). ` +
        'Якщо порт 15672 перемаплено, задай BROKER_MANAGEMENT_URL=http://<host>:<port>/api',
    );
  }
  if (!res.ok) throw new Error(`management API ${method} ${pathname} → ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
