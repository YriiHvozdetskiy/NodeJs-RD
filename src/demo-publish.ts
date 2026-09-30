import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { checkout } from './checkout/checkout';
import { ConsumerProcess, DEMO_POINTS_PER_UNIT, demoFixture, depth, earned, openBroker, resetQueues, Summary } from './messaging/demo-kit';
import { orderPlacedEvent } from './messaging/order-placed.event';
import { EventPublisher } from './messaging/publisher';
import { LOYALTY_DLQ, LOYALTY_QUEUE } from './messaging/topology';

/**
 * demo:publish — happy path. П'ять оформлень через ту саму транзакцію
 * checkout(), що й POST /v1/orders; після кожного COMMIT — order.placed через
 * confirm-канал; споживач окремим процесом нараховує бали й підтверджує.
 *
 * Інваріант: 5 опубліковано → 5 ефектів у базі → 5 ack → 0 у DLQ і 0 у черзі,
 * а prefetch — задане число, не дефолтний 0.
 *
 * Потрібні build + migrate. Сід не потрібен: товар і покупець — свої.
 */
const ORDERS = 5;

async function main(): Promise<void> {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const broker = await openBroker();
  const publisher = new EventPublisher(async () => broker.url);
  const summary = new Summary();
  let consumer: ConsumerProcess | undefined;

  try {
    await resetQueues(broker);
    const { buyerId, productId } = await demoFixture(dataSource, 'demo:publish');
    const loyalty = (consumer = new ConsumerProcess());
    await loyalty.ready();
    console.log(`── demo:publish: ${ORDERS} оформлень → ${ORDERS}× order.placed → споживач балів (prefetch=${loyalty.prefetch}) ──`);

    const orderIds: string[] = [];
    let published = 0;
    for (let i = 0; i < ORDERS; i++) {
      const order = await checkout(dataSource, { buyerId, lines: [{ productId, qty: 1 }] });
      orderIds.push(order.orderId);
      // Рахуємо лише підтверджене брокером: publish кидає на nack, на
      // unroutable (basic.return) і на таймаут confirm.
      await publisher.publish(orderPlacedEvent(order));
      published += 1;
    }

    await loyalty.until(`${ORDERS} ack`, () => loyalty.count('acked') >= ORDERS);
    await loyalty.stop();

    const { rows: effect, points } = await earned(dataSource, orderIds);
    const work = await depth(broker.ch, LOYALTY_QUEUE);
    const dlq = await depth(broker.ch, LOYALTY_DLQ);
    const handleMs = loyalty.of('acked').map((r) => r.ms);

    summary.line('published', published);
    summary.line('delivered', loyalty.count('recv'));
    summary.line('effect', effect);
    summary.line('acked', loyalty.count('acked'));
    summary.line('dlq', dlq);
    summary.line('work', work);
    summary.line('prefetch', loyalty.prefetch);
    summary.line('points', points);
    // Від отримання до ack. Перша доставка платить ще й за відкриття зʼєднання
    // пулу, тому поруч із максимумом — медіана: саме вона йде у формулу prefetch.
    summary.line('handle-ms-median', [...handleMs].sort((a, b) => a - b)[Math.floor(handleMs.length / 2)] ?? 0);
    summary.line('handle-ms-max', Math.max(0, ...handleMs));

    summary.expect(`published=${ORDERS}`, published === ORDERS);
    summary.expect('effect = published (кожна подія — рівно одне нарахування)', effect === published);
    summary.expect('acked = published', loyalty.count('acked') === published);
    summary.expect(`points = ${ORDERS} × ${DEMO_POINTS_PER_UNIT}`, points === ORDERS * DEMO_POINTS_PER_UNIT);
    summary.expect('dlq=0 і work=0', dlq === 0 && work === 0);
    summary.expect('1 ≤ prefetch ≤ 2000', loyalty.prefetch >= 1 && loyalty.prefetch <= 2000);
  } finally {
    await consumer?.stop();
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
