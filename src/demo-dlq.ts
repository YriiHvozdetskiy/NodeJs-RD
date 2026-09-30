import { ConsumerProcess, depth, openBroker, resetQueues, Summary, waitFor } from './messaging/demo-kit';
import { orderPlacedEvent } from './messaging/order-placed.event';
import { EventPublisher } from './messaging/publisher';
import { DELIVERY_LIMIT, EVENTS_EXCHANGE, LOYALTY_DLQ, LOYALTY_QUEUE, ORDER_PLACED } from './messaging/topology';

/**
 * demo:dlq — повідомлення, яке не обробиться ніколи, іде окремим контуром, а
 * не крутиться в черзі вічно.
 *
 *   npm run demo:dlq                — валідна подія про замовлення, якого немає.
 *                                     Споживач не знає, що це назавжди, і
 *                                     повертає її в чергу; зупиняє цикл
 *                                     delivery-limit → причина delivery_limit
 *   npm run demo:dlq -- --contract  — тіло не за контрактом. Повтор дасть те
 *                                     саме, тож reject(requeue=false) з першої
 *                                     доставки → причина rejected
 *
 * Причину демо читає з самого мерця — заголовки x-death і x-first-death-reason
 * ставить брокер, коли перекладає повідомлення в DLX. Повідомлення лишається
 * в DLQ і після демо: його видно в UI, http://127.0.0.1:15672 → Queues →
 * loyalty.order.placed.dlq → Get messages.
 *
 * Потрібні лише брокер і build: замовлення в базі цьому демо не потрібне
 * саме тому, що його немає.
 */
const contractMode = process.argv.includes('--contract');
const DEATH_REASONS = ['rejected', 'expired', 'maxlen', 'delivery_limit'];

/** Замовлення з таким id не буває: identity починається з 1. */
const MISSING_ORDER = '0';

async function main(): Promise<void> {
  const broker = await openBroker();
  const publisher = new EventPublisher(async () => broker.url);
  const summary = new Summary();
  let consumer: ConsumerProcess | undefined;

  try {
    await resetQueues(broker);
    const loyalty = (consumer = new ConsumerProcess());
    await loyalty.ready();

    if (contractMode) {
      console.log('── demo:dlq --contract: тіло не за контрактом → reject(requeue=false) → DLX ──');
      // Сирий publish повз EventPublisher: справжній продюсер такого тіла не
      // збудує — схема не дасть. Так виглядає подія від зламаного чужого сервісу.
      broker.ch.publish(EVENTS_EXCHANGE, ORDER_PLACED, Buffer.from('{"eventId": "не-uuid", "type": "order.placed", "data": '), {
        persistent: true,
        mandatory: true,
        messageId: 'poison-contract',
      });
      await broker.ch.waitForConfirms();
    } else {
      console.log(`── demo:dlq: подія про неіснуюче замовлення → reject(requeue=true) × (delivery-limit ${DELIVERY_LIMIT} + 1) → DLX ──`);
      await publisher.publish(
        orderPlacedEvent({
          orderId: MISSING_ORDER,
          buyerId: MISSING_ORDER,
          currency: 'UAH',
          totalCents: 100_000,
          placedAt: new Date().toISOString(),
          lines: [{ productId: MISSING_ORDER, qty: 1 }],
        }),
      );
    }

    await waitFor('повідомлення в DLQ', async () => (await depth(broker.ch, LOYALTY_DLQ)) === 1);
    await loyalty.stop();

    // Заглядаємо в мерця й повертаємо його на місце: DLQ — склад доказів, а
    // не смітник. Ліміт повернень у DLQ знято політикою (delivery-limit -1),
    // тож перегляд його не зʼїдає.
    const dead = await broker.ch.get(LOYALTY_DLQ, { noAck: false });
    if (!dead) throw new Error('DLQ щойно показала 1 повідомлення, а get нічого не віддав');
    const headers = dead.properties.headers ?? {};
    const [death] = headers['x-death'] ?? [];
    // amqplib 2.0.1 типізує reason лише як 'rejected' | 'expired' | 'maxlen' —
    // delivery_limit у типах немає, хоча брокер його ставить. Тому рядок.
    const reason: string = death?.reason ?? 'none';
    const firstReason: string = headers['x-first-death-reason'] ?? 'none';
    broker.ch.nack(dead, false, true);
    await waitFor('мертве повідомлення повернулось у DLQ', async () => (await depth(broker.ch, LOYALTY_DLQ)) === 1);

    const work = await depth(broker.ch, LOYALTY_QUEUE);
    const dlq = await depth(broker.ch, LOYALTY_DLQ);
    const rejected = loyalty.count('rejected');
    const effect = loyalty.count('applied');

    summary.line('rejected', rejected);
    summary.line('work', work);
    summary.line('dlq', dlq);
    summary.line('dlq-reason', reason);
    summary.line('effect', effect);
    summary.line('deliveries', loyalty.count('recv'));
    summary.line('delivery-limit', DELIVERY_LIMIT);
    console.log(`x-death: queue=${death?.queue} reason=${death?.reason} count=${death?.count} routing-keys=${JSON.stringify(death?.['routing-keys'])}`);
    console.log(`x-first-death-reason: ${firstReason} · x-first-death-queue: ${headers['x-first-death-queue']}`);

    const expected = contractMode ? 'rejected' : 'delivery_limit';
    summary.expect('work=0 і dlq=1', work === 0 && dlq === 1);
    summary.expect(`dlq-reason — одна з чотирьох причин`, DEATH_REASONS.includes(reason));
    summary.expect(`dlq-reason=${expected} для цього режиму`, reason === expected && firstReason === expected);
    summary.expect('effect=0 — отруєне повідомлення не застосувалось', effect === 0);
    summary.expect(
      contractMode ? 'rejected=1 — битий контракт не повторюють' : `rejected=${DELIVERY_LIMIT + 1} — ліміт спрацював після ${DELIVERY_LIMIT} повернень`,
      rejected === (contractMode ? 1 : DELIVERY_LIMIT + 1),
    );
  } finally {
    await consumer?.stop();
    await publisher.close();
    await broker.connection.close().catch(() => undefined);
  }
  summary.finish();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
