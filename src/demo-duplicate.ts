import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { checkout } from './checkout/checkout';
import { ConsumerProcess, DEMO_POINTS_PER_UNIT, demoFixture, depth, earned, openBroker, resetQueues, Summary, waitFor } from './messaging/demo-kit';
import { orderPlacedEvent } from './messaging/order-placed.event';
import { EventPublisher } from './messaging/publisher';
import { LOYALTY_DLQ, LOYALTY_QUEUE } from './messaging/topology';

/**
 * demo:duplicate — дубль доставлено, а ефект застосовано один раз.
 *
 * Повторна доставка — справжній kill -9 процесу-споживача між ефектом і ack:
 *
 *   споживач №1  отримав подію → нарахував бали (COMMIT) → [вікно] → ack
 *                                                             ▲
 *                                                          SIGKILL
 *   брокер       бачить обрив TCP, ack не було → повідомлення знову ready
 *   споживач №2  отримав ту саму подію (redelivered) → INSERT … ON CONFLICT
 *                DO NOTHING → 0 рядків → дубль, ефект не повторено → ack
 *
 * Вікно між ефектом і ack у проді — мікросекунди, але воно є завжди. Демо
 * розширює його до 10 с (CONSUMER_ACK_DELAY_MS), щоб влучати детерміновано.
 * Не channel.close(): це коректне завершення, яке брокер теж requeue-ить, але
 * падіння в проді виглядає як обрив, і показати треба саме його.
 *
 * Потрібні build + migrate.
 */
const ACK_WINDOW_MS = 10_000;

async function main(): Promise<void> {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const broker = await openBroker();
  const publisher = new EventPublisher(async () => broker.url);
  const summary = new Summary();
  const started: ConsumerProcess[] = [];

  try {
    await resetQueues(broker);
    const { buyerId, productId } = await demoFixture(dataSource, 'demo:duplicate');

    const first = new ConsumerProcess({ CONSUMER_ACK_DELAY_MS: String(ACK_WINDOW_MS) });
    started.push(first);
    await first.ready();
    console.log('── demo:duplicate: ефект → SIGKILL до ack → брокер повертає → другий споживач ──');

    const order = await checkout(dataSource, { buyerId, lines: [{ productId, qty: 1 }] });
    await publisher.publish(orderPlacedEvent(order));

    await first.until('перший споживач застосував ефект', () => first.count('applied') === 1);
    await first.kill();
    console.log(`споживач №1: ефект застосовано, ack не відправлено — SIGKILL`);
    await waitFor('брокер повернув повідомлення в чергу', async () => (await depth(broker.ch, LOYALTY_QUEUE)) === 1);

    const second = new ConsumerProcess();
    started.push(second);
    await second.ready();
    await second.until('другий споживач підтвердив', () => second.count('acked') === 1);
    await second.stop();

    const [redelivery] = second.of('recv');
    const deliveries = first.count('recv') + second.count('recv');
    const { rows: effect, points } = await earned(dataSource, [order.orderId]);
    const skipped = second.count('duplicate');
    const work = await depth(broker.ch, LOYALTY_QUEUE);
    const dlq = await depth(broker.ch, LOYALTY_DLQ);

    summary.line('deliveries', deliveries);
    summary.line('effect', effect);
    summary.line('skipped', skipped);
    summary.line('points', points);
    summary.line('acked-before-kill', first.count('acked'));
    summary.line('redelivered', redelivery?.redelivered ? 1 : 0);
    summary.line('delivery-count', redelivery?.deliveryCount ?? 0);
    summary.line('work', work);
    summary.line('dlq', dlq);

    summary.expect('deliveries ≥ 2 — дубль справді доставлено', deliveries >= 2);
    summary.expect('effect=1 — ефект один, хоч доставок дві', effect === 1);
    summary.expect('skipped ≥ 1 — повтор розпізнано як дубль', skipped >= 1);
    summary.expect(`points=${DEMO_POINTS_PER_UNIT} — сума не подвоїлась`, points === DEMO_POINTS_PER_UNIT);
    summary.expect('перший споживач не встиг ack — інакше дубля не було б', first.count('acked') === 0);
    summary.expect('друга доставка позначена redelivered', redelivery?.redelivered ?? false);
    summary.expect('work=0 і dlq=0', work === 0 && dlq === 0);
  } finally {
    for (const consumer of started) await consumer.stop();
    await publisher.close();
    await broker.connection.close().catch(() => undefined);
    await dataSource.destroy();
  }
  summary.finish();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
