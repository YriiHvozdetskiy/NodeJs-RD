import { DataSource } from 'typeorm';
import { checkout } from './checkout/checkout';
import { dataSourceOptions } from './data-source';
import {
  ConsumerProcess,
  DEMO_POINTS_PER_UNIT,
  demoFixture,
  earned,
  flushOutbox,
  migrate,
  openBroker,
  outboxOf,
  processedOf,
  RelayProcess,
  resetQueues,
  Summary,
  waitFor,
} from './messaging/demo-kit';
import { orderPlacedEventId } from './messaging/order-placed.event';

/**
 * ⭐ demo:crash-relay — падає СЛУЖБОВИЙ запис. Relay помирає рівно між publish
 * і UPDATE published_at — справжнім kill -9 дочірнього процесу:
 *
 *   relay №1   оренда (SKIP LOCKED) → attempts+1 → COMMIT → publish → брокер
 *              підтвердив → [вікно] → UPDATE published_at
 *                               ▲
 *                            SIGKILL
 *   Postgres   оренда й attempts=1 закомічені, published_at лишився NULL — для
 *              бази публікації не було, а спроба була
 *   relay №2   оренда спливла → бере той самий рядок → attempts=2 → publish
 *              ВДРУГЕ → UPDATE published_at
 *   споживач   доставка 1 → бали нараховано, позначка в processed_messages
 *              доставка 2 → processed_messages: конфлікт → дубль, ефекту немає
 *
 * Доставок дві, ефект один. Це не баг relay, а його контракт: at-least-once.
 * Exactly-once РЕЗУЛЬТАТ дає не брокер і не relay, а ідемпотентний споживач.
 * А `attempts=2` — що спробу вбитого relay видно в лічильнику, і алерт на
 * рядок, який relay раз у раз не доносить, її побачить.
 *
 * Relay №1 — dist/demo-relay.js: той самий цикл, але з двійником відправника,
 * що після confirm тримає паузу. Без неї вікно між publish і позначкою —
 * мілісекунди, і влучити в нього SIGKILL-ом можна лише навмання. Relay №2 —
 * робочий dist/relay.js.
 */
async function main(): Promise<void> {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const broker = await openBroker();
  const summary = new Summary();
  const workers: (ConsumerProcess | RelayProcess)[] = [];

  try {
    const migrations = await migrate(dataSource);
    await resetQueues(broker, { purgeDlq: false });
    const backlog = await flushOutbox(dataSource, broker);
    const { buyerId, productId } = await demoFixture(dataSource, 'demo:crash-relay');

    const consumer = new ConsumerProcess();
    workers.push(consumer);
    await consumer.ready();
    console.log('── demo:crash-relay: publish → SIGKILL relay до UPDATE published_at → другий relay → споживач ──');

    const order = await checkout(dataSource, { buyerId, lines: [{ productId, qty: 1 }] });
    const eventId = orderPlacedEventId(order.orderId);

    const first = new RelayProcess('demo-relay.js');
    workers.push(first);
    await first.ready();
    await first
      .until('relay №1 опублікував подію', () => first.publishesOf(eventId) > 0)
      .catch((err: unknown) => {
        // Рядок забрав хтось інший — вбудований relay `npm run start` чи `npm run relay`.
        throw new Error(`${err instanceof Error ? err.message : String(err)}. Зупини npm run start / npm run relay і повтори`);
      });
    await first.kill();
    console.log('relay №1: брокер підтвердив publish, UPDATE published_at не виконано — SIGKILL');

    const afterKill = await outboxOf(dataSource, [order.orderId]);

    // Рядок в оренді вбитого relay, доки та не спливе (2 с у demo-relay).
    // Relay №2 просто опитує, поки не візьме.
    const second = new RelayProcess();
    workers.push(second);
    await second.ready();
    await waitFor('relay №2 виніс подію', async () => (await outboxOf(dataSource, [order.orderId])).published === 1, 30_000);
    await consumer.until('споживач підтвердив обидві доставки', () => consumer.of('acked').filter((r) => r.eventId === eventId).length >= 2);
    await second.stop();
    await consumer.stop();

    const outbox = await outboxOf(dataSource, [order.orderId]);
    const { rows: effect, points } = await earned(dataSource, [order.orderId]);
    const processed = await processedOf(dataSource, [eventId]);
    const deliveries = consumer.deliveriesOf(eventId);
    const applied = consumer.of('applied').filter((r) => r.eventId === eventId).length;
    const duplicates = consumer.of('duplicate').filter((r) => r.eventId === eventId);
    const publishes = first.publishesOf(eventId) + second.committedOf(eventId);

    summary.line('published', outbox.published);
    summary.line('deliveries', deliveries);
    summary.line('applied', applied);
    summary.line('effect', effect);
    summary.line('processed', processed);
    summary.line('publishes', publishes);
    summary.line('duplicates', duplicates.length);
    summary.line('duplicates-by-inbox', duplicates.filter((d) => d.by === 'inbox').length);
    summary.line('published-after-kill', afterKill.published);
    summary.line('attempts-after-kill', afterKill.attempts);
    summary.line('committed-by-killed-relay', first.count('committed'));
    summary.line('attempts', outbox.attempts);
    summary.line('points', points);
    summary.line('backlog-flushed', backlog);
    summary.line('migrations-applied', migrations);

    summary.expect('relay №1 не встиг COMMIT — інакше дубля не було б', first.count('committed') === 0 && afterKill.published === 0);
    summary.expect('publishes ≥ 2 — подію опубліковано вдруге', publishes >= 2);
    summary.expect('deliveries ≥ 2 — дубль справді доставлено', deliveries >= 2);
    summary.expect('applied=1 і effect=1 — ефект один, хоч доставок дві', applied === 1 && effect === 1);
    summary.expect('processed=1 — одна позначка inbox на подію', processed === 1);
    summary.expect('published=1 — після рестарту relay рядок винесено', outbox.published === 1);
    summary.expect('повтор розпізнано як дубль', duplicates.length >= 1);
    summary.expect('attempts-after-kill=1 — спроба вбитого relay пережила його', afterKill.attempts === 1);
    summary.expect('attempts = publishes — кожна спроба в лічильнику', outbox.attempts === publishes);
    summary.expect(`points=${DEMO_POINTS_PER_UNIT} — сума не подвоїлась`, points === DEMO_POINTS_PER_UNIT);
  } finally {
    for (const worker of workers) await worker.stop();
    await broker.connection.close().catch(() => undefined);
    await dataSource.destroy();
  }
  summary.finish();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
