import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import { APP_OPTIONS, configureApp } from './app.setup';
import { dataSourceOptions } from './data-source';
import { cliDbConfig } from './db/cli-env';
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
} from './messaging/demo-kit';
import { orderPlacedEventId } from './messaging/order-placed.event';

/**
 * demo:outbox — happy path #22, від HTTP до ефекту:
 *
 *   POST /v1/orders ×2 з тим самим Idempotency-Key   ← рівень 3: одне замовлення
 *     │ одна транзакція: orders + outbox + idempotency_keys
 *     ▼
 *   relay (dist/relay.js): SKIP LOCKED → publish → UPDATE published_at
 *     │ RabbitMQ
 *     ▼
 *   споживач (dist/consumer.js): processed_messages + points_entries — одна транзакція
 *
 * Другий запит — клієнт, що не дочекався відповіді й повторив: той самий ключ,
 * те саме тіло. Сервер не оформлює вдруге, а віддає вже створене замовлення з
 * `Idempotency-Replay: true`.
 *
 * Застосунок — справжній AppModule на ефемерному порту, тим самим
 * configureApp, що й main.ts: валідатор спеки, problem+json, префікс /v1.
 * Вбудований relay вимкнено (BROKER_URL порожній) — подію виносить relay-процес
 * демо, щоб було видно, хто саме це зробив.
 */
async function main(): Promise<void> {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const broker = await openBroker();
  const summary = new Summary();
  const workers: (ConsumerProcess | RelayProcess)[] = [];
  let api: Api | undefined;

  try {
    const migrations = await migrate(dataSource);
    await resetQueues(broker, { purgeDlq: false });
    const backlog = await flushOutbox(dataSource, broker);
    const { productId } = await demoFixture(dataSource, 'demo:outbox');

    const consumer = new ConsumerProcess();
    workers.push(consumer);
    await consumer.ready();
    api = await startApi();
    console.log('── demo:outbox: 2× POST з тим самим Idempotency-Key → outbox → relay → споживач ──');

    const key = `demo-outbox-${randomUUID()}`;
    const body = { items: [{ product_id: Number(productId), qty: 1 }] };
    const responses: { status: number; replay: boolean; id: number }[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${api.url}/v1/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json();
      if (!res.ok) throw new Error(`POST /v1/orders → ${res.status}: ${JSON.stringify(json)}`);
      responses.push({ status: res.status, replay: res.headers.get('idempotency-replay') === 'true', id: orderIdOf(json) });
    }

    // Замовлення рахуються з бази, а не з відповідей: товар свій на кожен прогін,
    // тож усе, що в нього є, оформлене саме цими двома запитами.
    const orderIds: string[] = (
      await dataSource.query(`SELECT DISTINCT order_id::text AS id FROM order_items WHERE product_id = $1`, [productId])
    ).map((r: { id: string }) => r.id);
    const eventIds = orderIds.map(orderPlacedEventId);

    // BROKER_URL явно: startApi обнулив його в оточенні цього процесу, щоб
    // вимкнути вбудований relay, а нащадок успадкував би порожній рядок.
    const relay = new RelayProcess({ BROKER_URL: broker.url });
    workers.push(relay);
    await relay.ready();
    await relay.until('relay виніс подію', () => eventIds.every((id) => relay.of('committed').some((r) => r.ids.includes(id))));
    await consumer.until('споживач підтвердив подію', () =>
      eventIds.every((id) => consumer.of('acked').some((r) => r.eventId === id)),
    );
    await relay.stop();
    await consumer.stop();

    const outbox = await outboxOf(dataSource, orderIds);
    const { rows: effect, points } = await earned(dataSource, orderIds);
    const deliveries = eventIds.reduce((sum, id) => sum + consumer.deliveriesOf(id), 0);
    const processed = await processedOf(dataSource, eventIds);
    const [{ keys }] = await dataSource.query(`SELECT count(*)::int AS keys FROM idempotency_keys WHERE key = $1`, [key]);
    const [first, second] = responses;

    summary.line('requests', responses.length);
    summary.line('orders', orderIds.length);
    summary.line('outbox', outbox.rows);
    summary.line('published', outbox.published);
    summary.line('deliveries', deliveries);
    summary.line('effect', effect);
    summary.line('processed', processed);
    summary.line('replayed', responses.filter((r) => r.replay).length);
    summary.line('same-order', first.id === second.id ? 1 : 0);
    summary.line('status-first', first.status);
    summary.line('status-second', second.status);
    summary.line('idempotency-keys', keys);
    summary.line('points', points);
    summary.line('backlog-flushed', backlog);
    summary.line('migrations-applied', migrations);

    summary.expect('requests=2', responses.length === 2);
    summary.expect('orders=1 — два запити з одним ключем дали одне замовлення', orderIds.length === 1);
    summary.expect('outbox=1 і published=1 — одна подія, і її винесено', outbox.rows === 1 && outbox.published === 1);
    summary.expect('deliveries ≥ 1', deliveries >= 1);
    summary.expect('effect=1 і processed=1', effect === 1 && processed === 1);
    summary.expect('другий запит — replay того самого замовлення', !first.replay && second.replay && first.id === second.id);
    summary.expect('обидві відповіді 201', first.status === 201 && second.status === 201);
    summary.expect(`points=${DEMO_POINTS_PER_UNIT}`, points === DEMO_POINTS_PER_UNIT);
  } finally {
    for (const worker of workers) await worker.stop();
    await api?.close();
    await broker.connection.close().catch(() => undefined);
    await dataSource.destroy();
  }
  summary.finish();
}

interface Api {
  url: string;
  close(): Promise<void>;
}

/**
 * AppModule у цьому ж процесі. Підключення — тим самим каналом, що в проді
 * (#11): адреса в DB_URL без пароля, пароль файлом. Значення беруться з тих
 * DB_*, що дала обгортка with-secrets, тож сховище чи SKIP_VAULT=1 — однаково.
 *
 * Імпорт AppModule динамічний і ПІСЛЯ env: ConfigModule.forRoot() валідує
 * оточення в момент імпорту файла (той самий прийом, що в test/testkit/app.ts).
 * Локальний .env, якщо він є, явно заданих тут ключів не перебиває.
 */
async function startApi(): Promise<Api> {
  const db = cliDbConfig();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-outbox-'));
  const passwordFile = path.join(dir, 'db_password');
  await writeFile(passwordFile, db.password, { mode: 0o600 });

  Object.assign(process.env, {
    DB_URL: `postgres://${encodeURIComponent(db.user)}@${db.host}:${db.port}/${encodeURIComponent(db.database)}`,
    DB_PASSWORD_FILE: passwordFile,
    BROKER_URL: '',
    DRIFT: '0',
    SLOW_MS: '0',
    CORS_ORIGINS: '',
  });
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { ...APP_OPTIONS, logger: ['error', 'warn'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();

  return {
    url,
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function orderIdOf(json: unknown): number {
  if (typeof json === 'object' && json !== null && 'id' in json && typeof json.id === 'number') return json.id;
  throw new Error(`у відповіді немає id: ${JSON.stringify(json)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
