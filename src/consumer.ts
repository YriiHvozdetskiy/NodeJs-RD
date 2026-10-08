import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import * as amqp from 'amqplib';
import type { ConsumeMessage } from 'amqplib';
import { Pool } from 'pg';
import { cliDbConfig, requiredEnv } from './db/cli-env';
import { accruePointsOnce } from './loyalty/points-accrual';
import { ContractError, parseOrderPlaced } from './messaging/order-placed.event';
import { assertLoyaltyTopology, DELIVERY_LIMIT, LOYALTY_QUEUE } from './messaging/topology';

/**
 * Споживач order.placed → нарахування бонусних балів. Окремий процес, а не
 * провайдер у застосунку: його можна масштабувати, зупиняти й убивати
 * незалежно від API — і саме вбивством demo:duplicate показує дубль.
 *
 *   npm run consumer    ≡ bash scripts/with-secrets.sh dev node dist/consumer.js
 *
 * Гарантія — at-least-once: ack відправляється ПІСЛЯ ефекту. Упав між ефектом
 * і ack — брокер поверне повідомлення, і ефект спробує статися вдруге. З #22
 * дублі приходять ще й від relay outbox, який помер між publish і UPDATE
 * published_at. Тому ефект ідемпотентний на двох рівнях — inbox
 * processed_messages і природний ключ (src/loyalty/points-accrual.ts), — і
 * разом це дає один результат на подію. Exactly-once ДОСТАВКИ тут немає і бути
 * не може.
 *
 * Ack — не «дійшло», а «я більше не вимагаю повтору». Три вердикти:
 *   ack              ефект застосовано або вже був (дубль) — повторювати нічого;
 *   reject(false)    битий контракт — повтор дасть те саме, одразу в DLX;
 *   reject(true)     будь-що інше — ще спроба; межа — delivery-limit, далі DLX.
 */

/**
 * prefetch = розмір пулу БД цього процесу. Обробка одного повідомлення — один
 * INSERT (кілька мс), доставки обробляються паралельно, і кожна тримає одне
 * зʼєднання. Більше непідтверджених, ніж зʼєднань, чекали б у памʼяті цього
 * процесу, звідки їх не забере другий інстанс; менше — пул простоював би.
 * Межа зверху: 10 × час обробки ≪ consumer_timeout (стокові 30 хв).
 */
export const PREFETCH = 10;

/**
 * Пауза між ефектом і ack — ЛИШЕ для demo:duplicate. У проді ця щілина
 * мікроскопічна, але вона є завжди, і саме в неї влучає падіння, що дає дубль.
 * Демо її розширює, щоб влучити SIGKILL-ом детерміновано, а не навмання.
 */
const ACK_DELAY_MS = Number(process.env.CONSUMER_ACK_DELAY_MS ?? 0);

/**
 * Пауза перед поверненням у чергу: 250 мс × 2^(повернень уже), стеля 4 с.
 * Без неї п'ять повернень delivery-limit спалювались за мілісекунди, і
 * секундний збій бази відправляв у DLQ усе, що було в роботі. З нею між
 * першою доставкою й DLQ — 0,25 + 0,5 + 1 + 2 + 4 = 7,75 с: короткий збій
 * переживається, а не розміняний на мерців.
 *
 * Пауза тримає повідомлення непідтвердженим і займає слот prefetch. Це
 * свідомо: поки база лежить, брати нові доставки нема сенсу. Межа зверху —
 * 10 слотів × 4 с, далеко від consumer_timeout. Справжній retry з паузою поза
 * споживачем (окрема черга з TTL, retry-with-jitter) — #22.
 */
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 4_000;

export function retryDelayMs(deliveryCount: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** deliveryCount, RETRY_MAX_MS);
}

/** Що споживач повідомляє батьківському процесу демо (IPC). Без демо — нікому. */
export type ConsumerReport =
  | { t: 'ready'; pid: number; prefetch: number }
  | { t: 'recv'; eventId: string; redelivered: boolean; deliveryCount: number }
  | { t: 'applied'; eventId: string; orderId: string; points: number }
  | { t: 'duplicate'; eventId: string; orderId: string; by: 'inbox' | 'natural-key' }
  | { t: 'not-eligible'; eventId: string; orderId: string }
  | { t: 'acked'; eventId: string; ms: number }
  | { t: 'rejected'; eventId: string; requeue: boolean; delayMs: number; error: string };

const report = (r: ConsumerReport) => process.send?.(r);
const log = (line: string) => console.log(`[loyalty ${process.pid}] ${line}`);

async function main(): Promise<void> {
  const brokerUrl = requiredEnv('BROKER_URL');
  const db = new Pool({ ...cliDbConfig(), max: PREFETCH });
  const connection = await amqp.connect(brokerUrl);
  const ch = await connection.createChannel();

  let stopping = false;
  // Перериває паузи перед поверненням: на SIGTERM повідомлення повертається
  // одразу, а не через 4 с, — docker stop не мусить чекати на чужий backoff.
  const stopSignal = new AbortController();
  // Відновлення зʼєднання свідомо немає: процес, що втратив брокер, виходить
  // із кодом 1, а перезапуск — справа супервізора (compose, k8s). Незасвідчені
  // повідомлення брокер уже повернув у чергу — підхопить інший інстанс.
  const die = (why: string) => {
    if (stopping) return;
    log(`${why} — виходжу з кодом 1`);
    process.exit(1);
  };
  connection.on('error', (err: Error) => log(`зʼєднання: ${err.message}`));
  connection.on('close', () => die('брокер закрив зʼєднання'));
  ch.on('error', (err: Error) => log(`канал: ${err.message}`));
  ch.on('close', () => die('канал закрито'));

  // Топологію оголошує споживач: він знає, яку чергу слухає і куди мають іти
  // його мерці. Ідемпотентно — повторний assert тих самих параметрів нічого не міняє.
  await assertLoyaltyTopology(ch, brokerUrl);
  // Дефолт брокера — 0, тобто «без ліміту»: перший підписаний споживач забрав
  // би всю чергу собі в памʼять, а другий простоював би.
  await ch.prefetch(PREFETCH);

  const inFlight = new Set<Promise<void>>();

  async function handle(msg: ConsumeMessage): Promise<void> {
    const started = performance.now();
    const eventId = typeof msg.properties.messageId === 'string' ? msg.properties.messageId : '?';
    // Скільки разів повідомлення вже поверталось. Перша доставка заголовка не має.
    const deliveryCount = Number(msg.properties.headers?.['x-delivery-count'] ?? 0);
    report({ t: 'recv', eventId, redelivered: msg.fields.redelivered, deliveryCount });

    let requeue: boolean | undefined;
    try {
      const event = parseOrderPlaced(msg.content);
      const { orderId } = event.data;
      // eventId з тіла, а не messageId з властивостей: тіло пройшло схему, тож
      // це гарантовано UUID — тип колонки processed_messages.message_id.
      const outcome = await accruePointsOnce(db, { eventId: event.eventId, orderId, consumer: LOYALTY_QUEUE });
      if (outcome.kind === 'applied') {
        report({ t: 'applied', eventId, orderId, points: outcome.points });
        log(`замовлення ${orderId}: +${outcome.points} балів (pending)`);
      } else if (outcome.kind === 'duplicate') {
        report({ t: 'duplicate', eventId, orderId, by: outcome.by });
        log(`замовлення ${orderId}: дубль (${outcome.by === 'inbox' ? 'подія вже в processed_messages' : 'нарахування вже є'}) — ефект не повторюю`);
      } else {
        report({ t: 'not-eligible', eventId, orderId });
        log(`замовлення ${orderId}: нема чого нараховувати`);
      }
    } catch (err) {
      requeue = !(err instanceof ContractError);
      const error = err instanceof Error ? err.message : String(err);
      // Остання доставка перед лімітом іде в DLX одразу: чекати на неї нічого.
      const delayMs = requeue && deliveryCount < DELIVERY_LIMIT ? retryDelayMs(deliveryCount) : 0;
      report({ t: 'rejected', eventId, requeue, delayMs, error });
      log(
        `${eventId}: ${error} → reject(requeue=${requeue})` +
          (requeue ? `, повернень уже ${deliveryCount}${delayMs ? `, пауза ${delayMs} мс` : ' — далі DLX'}` : ''),
      );
      if (delayMs > 0) await sleep(delayMs, undefined, { signal: stopSignal.signal }).catch(() => undefined);
    }

    if (requeue === undefined) {
      if (ACK_DELAY_MS > 0) await sleep(ACK_DELAY_MS);
      ch.ack(msg);
      report({ t: 'acked', eventId, ms: Math.round((performance.now() - started) * 10) / 10 });
    } else {
      // reject, а не nack: на 4.3 nack(requeue=true) НЕ інкрементить
      // delivery-count, і цикл повернень на ньому нічим не обмежений. На 4.2
      // інкрементують обидва (перевірено), тож reject — те, що тримає ліміт
      // на обох версіях.
      ch.reject(msg, requeue);
    }
  }

  const { consumerTag } = await ch.consume(
    LOYALTY_QUEUE,
    (msg) => {
      // null — не «порожнє повідомлення», а basic.cancel від брокера: чергу
      // видалили або спрацював consumer_timeout. Наївний `if (!msg) return`
      // лишив би процес живим і глухим — він слав би ack у канал, з якого
      // його вже відписали. Виходимо й даємо супервізору перезапустити.
      if (msg === null) {
        die('брокер скасував підписку (basic.cancel)');
        return;
      }
      const job = handle(msg)
        .catch((err: unknown) => log(`обробка впала поза вердиктом: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => inFlight.delete(job));
      inFlight.add(job);
    },
    // Ручний ack. `noAck: true` означало б «доставлено = записано в сокет»:
    // падіння процесу забрало б усе, що встигло приїхати, але не обробитись.
    { noAck: false },
  );

  report({ t: 'ready', pid: process.pid, prefetch: PREFETCH });
  log(`слухаю ${LOYALTY_QUEUE}, prefetch=${PREFETCH}`);

  // SIGTERM (docker stop, k8s) — коректне завершення: спершу відписатись, щоб
  // брокер перестав слати нове, потім дочекатись того, що вже в роботі, і
  // лише тоді закрити канал. Незасвідчене на момент закриття брокер поверне.
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    stopSignal.abort();
    log(`${signal}: відписуюсь, чекаю ${inFlight.size} в роботі`);
    await ch.cancel(consumerTag).catch(() => undefined);
    await Promise.allSettled(inFlight);
    await ch.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
    await db.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(`[loyalty ${process.pid}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
