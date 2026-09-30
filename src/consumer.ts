import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import * as amqp from 'amqplib';
import type { ConsumeMessage } from 'amqplib';
import { Pool } from 'pg';
import { cliDbConfig, requiredEnv } from './db/cli-env';
import { accruePoints } from './loyalty/points-accrual';
import { ContractError, parseOrderPlaced } from './messaging/order-placed.event';
import { assertLoyaltyTopology, LOYALTY_QUEUE } from './messaging/topology';

/**
 * Споживач order.placed → нарахування бонусних балів. Окремий процес, а не
 * провайдер у застосунку: його можна масштабувати, зупиняти й убивати
 * незалежно від API — і саме вбивством demo:duplicate показує дубль.
 *
 *   npm run consumer    ≡ bash scripts/with-secrets.sh dev node dist/consumer.js
 *
 * Гарантія — at-least-once: ack відправляється ПІСЛЯ ефекту. Упав між ефектом
 * і ack — брокер поверне повідомлення, і ефект спробує статися вдруге. Тому
 * ефект ідемпотентний (src/loyalty/points-accrual.ts), і разом це дає один
 * результат на подію. Exactly-once ДОСТАВКИ тут немає і бути не може.
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

/** Що споживач повідомляє батьківському процесу демо (IPC). Без демо — нікому. */
export type ConsumerReport =
  | { t: 'ready'; pid: number; prefetch: number }
  | { t: 'recv'; eventId: string; redelivered: boolean; deliveryCount: number }
  | { t: 'applied'; eventId: string; orderId: string; points: number }
  | { t: 'duplicate'; eventId: string; orderId: string }
  | { t: 'not-eligible'; eventId: string; orderId: string }
  | { t: 'acked'; eventId: string; ms: number }
  | { t: 'rejected'; eventId: string; requeue: boolean; error: string };

const report = (r: ConsumerReport) => process.send?.(r);
const log = (line: string) => console.log(`[loyalty ${process.pid}] ${line}`);

async function main(): Promise<void> {
  const brokerUrl = requiredEnv('BROKER_URL');
  const db = new Pool({ ...cliDbConfig(), max: PREFETCH });
  const connection = await amqp.connect(brokerUrl);
  const ch = await connection.createChannel();

  let stopping = false;
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
      const outcome = await accruePoints(db, orderId);
      if (outcome.kind === 'applied') {
        report({ t: 'applied', eventId, orderId, points: outcome.points });
        log(`замовлення ${orderId}: +${outcome.points} балів (pending)`);
      } else {
        report({ t: outcome.kind, eventId, orderId });
        log(`замовлення ${orderId}: ${outcome.kind === 'duplicate' ? 'уже нараховано — дубль, ефект не повторюю' : 'нема чого нараховувати'}`);
      }
    } catch (err) {
      requeue = !(err instanceof ContractError);
      const error = err instanceof Error ? err.message : String(err);
      report({ t: 'rejected', eventId, requeue, error });
      log(`${eventId}: ${error} → reject(requeue=${requeue})${requeue ? `, повернень уже ${deliveryCount}` : ''}`);
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
