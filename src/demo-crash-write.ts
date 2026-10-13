import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import type { IsolationLevel } from 'typeorm/driver/types/IsolationLevel';
import { checkout, type CheckoutResult } from './checkout/checkout';
import { dataSourceOptions } from './data-source';
import { sql } from './db/sql';
import {
  ConsumerProcess,
  demoFixture,
  earned,
  flushOutbox,
  migrate,
  openBroker,
  outboxOf,
  RelayProcess,
  resetQueues,
  Summary,
} from './messaging/demo-kit';

/**
 * demo:crash-write — падає БІЗНЕС-запис. Транзакція checkout валиться вже
 * ПІСЛЯ вставки рядка в outbox (і ключа ідемпотентності), за крок до COMMIT:
 *
 *   BEGIN
 *     UPDATE products … stock − 1
 *     INSERT orders, order_items, jobs
 *     INSERT outbox                  ← подія є, її видно цій транзакції
 *     INSERT idempotency_keys
 *     ✗ збій                         ← двійник DataSource кидає виняток
 *   ROLLBACK                         ← зникає все, і рядок outbox теж
 *
 * Поруч весь час працюють справжні relay і споживач. Якби outbox і замовлення
 * комітились окремо, relay побачив би подію про замовлення, якого немає, і
 * виніс би її. Тут виносити нічого: relay двічі опитує outbox після збою й
 * бачить порожньо, споживач не отримує нічого.
 *
 * Точки збою в checkout немає: його код той самий, що в проді. Збій вносить
 * тестовий двійник DataSource (crashingBeforeCommit нижче) — справжня
 * транзакція, у якій після всіх INSERT бізнес-операції і ДО COMMIT
 * кидається виняток. Перед ним двійник заглядає в таблиці зсередини тієї ж
 * транзакції: `outbox-in-tx=1` доводить, що рядок справді був вставлений, а
 * не просто не дійшов. Виняток, а не kill -9: для бізнес-запису обидва дають
 * ROLLBACK, а виняток дозволяє цей погляд зсередини.
 */
class SimulatedCrash extends Error {
  override readonly name = 'SimulatedCrash';
}

/**
 * Тестовий двійник DataSource: делегує справжньому, але обгортає роботу
 * транзакції — коли бізнес-операція повернулась (усі INSERT виконано, COMMIT ще
 * ні), викликає `crash`, а той кидає. Справжній `transaction()` на винятку
 * робить ROLLBACK, як і на будь-якому збої checkout.
 *
 * checkout кличе лише `transaction(isolation, run)` — іншої форми двійник не
 * підтримує. Решта властивостей іде до справжнього DataSource без змін.
 */
function crashingBeforeCommit(
  dataSource: DataSource,
  crash: (manager: EntityManager, placed: CheckoutResult) => Promise<never>,
): DataSource {
  return new Proxy(dataSource, {
    get(target, prop, receiver) {
      if (prop !== 'transaction') return Reflect.get(target, prop, receiver);
      return (isolation: IsolationLevel, run: (manager: EntityManager) => Promise<CheckoutResult>) =>
        target.transaction(isolation, async (manager) => crash(manager, await run(manager)));
    },
  });
}

async function main(): Promise<void> {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const broker = await openBroker();
  const summary = new Summary();
  const workers: (ConsumerProcess | RelayProcess)[] = [];

  try {
    const migrations = await migrate(dataSource);
    await resetQueues(broker, { purgeDlq: false });
    const backlog = await flushOutbox(dataSource, broker);
    const { buyerId, productId } = await demoFixture(dataSource, 'demo:crash-write');
    const stockBefore = await stockOf(dataSource, productId);

    const consumer = new ConsumerProcess();
    const relay = new RelayProcess();
    workers.push(consumer, relay);
    await Promise.all([consumer.ready(), relay.ready()]);
    await relay.until('relay опитав outbox', () => relay.count('idle') > 0);
    console.log('── demo:crash-write: INSERT outbox → збій до COMMIT → ROLLBACK; relay і споживач працюють поруч ──');

    const key = `demo-crash-write-${randomUUID()}`;
    let crashedOrderId = '';
    let outboxInTx = 0;
    let keysInTx = 0;
    let writeFailed = 0;
    const crashing = crashingBeforeCommit(dataSource, async (manager, placed) => {
      crashedOrderId = placed.orderId;
      [{ n: outboxInTx }] = await sql<{ n: number }>(manager, `SELECT count(*)::int AS n FROM outbox WHERE aggregate_id = $1`, [placed.orderId]);
      [{ n: keysInTx }] = await sql<{ n: number }>(manager, `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`, [key]);
      throw new SimulatedCrash(`збій бізнес-запису після INSERT outbox, замовлення ${placed.orderId} ще не закомічене`);
    });
    try {
      await checkout(crashing, { buyerId, lines: [{ productId, qty: 1 }] }, { idempotency: { key, fingerprint: 'demo:crash-write' } });
    } catch (err) {
      if (!(err instanceof SimulatedCrash)) throw err;
      writeFailed = 1;
      console.log(`✗ ${err.message} → ROLLBACK`);
    }

    // Не «поспати й сподіватись»: два повні опити relay ПІСЛЯ збою, і обидва
    // порожні. Подія, якби вона пережила ROLLBACK, була б винесена на першому.
    const idleBefore = relay.count('idle');
    await relay.until('relay двічі опитав outbox після збою', () => relay.count('idle') >= idleBefore + 2);
    await relay.stop();
    await consumer.stop();

    const [{ orders }] = await dataSource.query(`SELECT count(*)::int AS orders FROM orders WHERE id = $1`, [crashedOrderId || '0']);
    const outbox = await outboxOf(dataSource, [crashedOrderId]);
    const { rows: effect } = await earned(dataSource, [crashedOrderId || '0']);
    const [{ keys }] = await dataSource.query(`SELECT count(*)::int AS keys FROM idempotency_keys WHERE key = $1`, [key]);
    const stockAfter = await stockOf(dataSource, productId);
    const deliveries = consumer.count('recv');
    const relayed = relay.count('committed');

    summary.line('write-failed', writeFailed);
    summary.line('orders', orders);
    summary.line('outbox', outbox.rows);
    summary.line('published', outbox.published);
    summary.line('deliveries', deliveries);
    summary.line('effect', effect);
    summary.line('outbox-in-tx', outboxInTx);
    summary.line('idempotency-keys-in-tx', keysInTx);
    summary.line('idempotency-keys', keys);
    summary.line('relay-batches', relayed);
    summary.line('stock-before', stockBefore);
    summary.line('stock-after', stockAfter);
    summary.line('backlog-flushed', backlog);
    summary.line('migrations-applied', migrations);

    summary.expect('write-failed=1 — транзакція справді впала', writeFailed === 1);
    summary.expect('outbox-in-tx=1 — рядок outbox був вставлений до збою', outboxInTx === 1);
    summary.expect('orders=0 і outbox=0 — обидва рядки зникли разом', orders === 0 && outbox.rows === 0);
    summary.expect('published=0, deliveries=0, effect=0 — назовні не вийшло нічого', outbox.published === 0 && deliveries === 0 && effect === 0);
    summary.expect('relay не виніс жодного рядка', relayed === 0);
    summary.expect('ключ ідемпотентності був вставлений і теж відкотився', keysInTx === 1 && keys === 0);
    summary.expect('stock повернувся', stockAfter === stockBefore);
  } finally {
    for (const worker of workers) await worker.stop();
    await broker.connection.close().catch(() => undefined);
    await dataSource.destroy();
  }
  summary.finish();
}

async function stockOf(dataSource: DataSource, productId: string): Promise<number> {
  const [row] = await dataSource.query(`SELECT stock FROM products WHERE id = $1`, [productId]);
  return row.stock;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
