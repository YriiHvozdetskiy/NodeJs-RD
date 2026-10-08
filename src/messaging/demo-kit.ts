import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import type { DataSource } from 'typeorm';
import type { ConsumerReport } from '../consumer';
import { requiredEnv } from '../db/cli-env';
import { CENTS_PER_POINT } from '../loyalty/points-accrual';
import { relayBatch } from '../outbox/relay';
import type { RelayReport } from '../relay';
import { ORDER_AGGREGATE } from './order-placed.event';
import { EventPublisher } from './publisher';
import { assertLoyaltyTopology, LOYALTY_DLQ, LOYALTY_QUEUE } from './topology';

/**
 * Спільне для демо брокера (#19) і outbox (#22). Кожне демо:
 *   1. приводить стан до чистого — топологія, порожня робоча черга (DLQ — лише
 *      demo:dlq, див. resetQueues), винесені залишки outbox (flushOutbox);
 *   2. запускає СПРАВЖНІ робочі процеси (dist/consumer.js, dist/relay.js)
 *      окремо від себе;
 *   3. друкує підсумок рядками ключ=значення;
 *   4. сам перевіряє інваріант і виходить із кодом ≠ 0, якщо той порушено.
 */

/** Робочий процес у власному процесі ОС — щоб його можна було вбити по-справжньому. */
class WorkerProcess<R extends { t: string }> {
  readonly reports: R[] = [];
  private readonly proc: ChildProcess;
  private readonly exited: Promise<void>;

  constructor(
    private readonly label: string,
    script: string,
    env: Record<string, string>,
  ) {
    this.proc = fork(path.join(__dirname, '..', script), {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.proc.on('message', (m) => {
      if (isReport<R>(m)) this.reports.push(m);
    });
    this.exited = new Promise((resolve) => this.proc.once('exit', () => resolve()));
  }

  count(t: R['t']): number {
    return this.reports.filter((r) => r.t === t).length;
  }

  of<T extends R['t']>(t: T): Extract<R, { t: T }>[] {
    return this.reports.filter((r): r is Extract<R, { t: T }> => r.t === t);
  }

  /** Дочекатись стану, а не поспати навмання. Упав процес — чекати нема на що. */
  async until(what: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
        throw new Error(`${this.label} вийшов (${this.proc.signalCode ?? `код ${this.proc.exitCode}`}), не дочекавшись: ${what}`);
      }
      if (Date.now() > deadline) throw new Error(`не дочекались за ${timeoutMs} мс: ${what}`);
      await sleep(20);
    }
  }

  ready(): Promise<void> {
    return this.until(`${this.label} готовий`, () => this.count('ready') > 0);
  }

  /**
   * SIGKILL — не SIGTERM і не channel.close(). Коректне закриття — це фрейм
   * channel.close чи COMMIT поточного проходу. Падіння в проді виглядає
   * інакше: процес зникає, ОС закриває сокети, брокер і база бачать обрив.
   */
  async kill(): Promise<void> {
    this.proc.kill('SIGKILL');
    await this.exited;
  }

  /** SIGTERM — коректне завершення: доробити поточне, закрити зʼєднання. */
  async stop(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    this.proc.kill('SIGTERM');
    const forced = setTimeout(() => this.proc.kill('SIGKILL'), 5_000);
    await this.exited;
    clearTimeout(forced);
  }
}

function isReport<R>(m: unknown): m is R {
  return typeof m === 'object' && m !== null && 't' in m;
}

/** Споживач order.placed → бали (dist/consumer.js). */
export class ConsumerProcess extends WorkerProcess<ConsumerReport> {
  constructor(env: Record<string, string> = {}) {
    super('споживач', 'consumer.js', env);
  }

  get prefetch(): number {
    return this.of('ready')[0]?.prefetch ?? 0;
  }

  /** Скільки доставок отримано саме цієї події: дублі рахуються, чужі події — ні. */
  deliveriesOf(eventId: string): number {
    return this.of('recv').filter((r) => r.eventId === eventId).length;
  }
}

/** Relay outbox (dist/relay.js). */
export class RelayProcess extends WorkerProcess<RelayReport> {
  constructor(env: Record<string, string> = {}) {
    super('relay', 'relay.js', env);
  }

  /** Скільки разів брокер підтвердив цю подію саме від цього relay. */
  publishesOf(id: string): number {
    return this.of('published').filter((r) => r.ids.includes(id)).length;
  }
}

export interface Broker {
  url: string;
  connection: ChannelModel;
  /** Confirm-канал для службових дій демо: purge, checkQueue, get, сирий publish. */
  ch: ConfirmChannel;
}

export async function openBroker(): Promise<Broker> {
  const url = requiredEnv('BROKER_URL');
  const connection = await amqp.connect(url);
  const ch = await connection.createConfirmChannel();
  return { url, connection, ch };
}

/**
 * Чистий старт: топологія є (демо — той самий бутстрап-крок, що й споживач),
 * робоча черга порожня, і ніхто інший її не слухає. Запущений у сусідньому
 * терміналі `npm run consumer` забирав би доставки собі, і числа демо стали б
 * випадковими — тому це відмова з поясненням, а не тиха гонка.
 *
 * DLQ чистить лише demo:dlq — він її господар і лишає в ній рівно одного
 * мерця для UI. demo:publish і demo:duplicate її не чіпають: інакше прогін
 * після demo:dlq зносив би того мерця, якого README обіцяє показати. Вони
 * рахують приріст DLQ за свій прогін — `dlqBefore` звідси.
 */
export async function resetQueues({ ch, url }: Broker, { purgeDlq }: { purgeDlq: boolean }): Promise<{ dlqBefore: number }> {
  await assertLoyaltyTopology(ch, url);
  const { consumerCount } = await ch.checkQueue(LOYALTY_QUEUE);
  if (consumerCount > 0) {
    throw new Error(`${LOYALTY_QUEUE} уже слухає ${consumerCount} споживач(ів) — зупини \`npm run consumer\` і повтори`);
  }
  await ch.purgeQueue(LOYALTY_QUEUE);
  if (purgeDlq) await ch.purgeQueue(LOYALTY_DLQ);
  return { dlqBefore: await depth(ch, LOYALTY_DLQ) };
}

/** Скільки READY у черзі. Unacked сюди не входять — тому міряємо, коли споживача вже немає. */
export async function depth(ch: ConfirmChannel, queue: string): Promise<number> {
  return (await ch.checkQueue(queue)).messageCount;
}

export async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`не дочекались за ${timeoutMs} мс: ${what}`);
    await sleep(50);
  }
}

/**
 * Покупець, продавець і СВІЙ товар на кожен прогін — як у demo:race: демо не
 * залежить ні від сіду, ні від попередніх прогонів. Ціна без акції, тож
 * кожна штука дає бали: 2500 грн → 25 балів.
 */
export const DEMO_PRICE_CENTS = 250_000;

export async function demoFixture(dataSource: DataSource, label: string): Promise<{ buyerId: string; productId: string }> {
  const upsertUser = async (email: string, role: 'buyer' | 'seller'): Promise<string> => {
    const [row] = await dataSource.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, '!', $2)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [email, role],
    );
    return String(row.id);
  };
  const buyerId = await upsertUser('broker-demo-buyer@marketplace.local', 'buyer');
  const sellerId = await upsertUser('broker-demo-seller@marketplace.local', 'seller');
  const [product] = await dataSource.query(
    `INSERT INTO products (seller_id, category, title, description, price_cents, stock)
     VALUES ($1, 'electronics', $2, 'Товар для demo:* ДЗ #19', $3, 1000)
     RETURNING id`,
    [sellerId, `${label} ${new Date().toISOString()}`, DEMO_PRICE_CENTS],
  );
  return { buyerId, productId: String(product.id) };
}

/**
 * Фактичний ефект у базі за цими замовленнями: скільки нарахувань `earned` і
 * на скільки балів. Рядків мало: неідемпотентне `UPDATE … SET amount = amount + n`
 * на повторі лишило б один рядок із подвоєною сумою — його ловить `points`.
 */
export async function earned(dataSource: DataSource, orderIds: string[]): Promise<{ rows: number; points: number }> {
  const [row] = await dataSource.query(
    `SELECT count(*)::int AS rows, COALESCE(sum(amount), 0)::int AS points
       FROM points_entries
      WHERE kind = 'earned' AND order_id = ANY($1::bigint[])`,
    [orderIds],
  );
  return { rows: row.rows, points: row.points };
}

/** Скільки балів дає одна штука демо-товару: 1 бал за кожні повні 100 грн. */
export const DEMO_POINTS_PER_UNIT = Math.floor(DEMO_PRICE_CENTS / CENTS_PER_POINT);

/** Підсумок демо: рядки ключ=значення + перевірка інваріантів. */
export class Summary {
  private readonly failures: string[] = [];

  line(key: string, value: number | string): void {
    console.log(`${key}=${value}`);
  }

  expect(invariant: string, ok: boolean): void {
    if (!ok) this.failures.push(invariant);
  }

  /** Код виходу — те, що читає грейдер і CI поруч із числами. */
  finish(): void {
    if (this.failures.length === 0) {
      console.log('✓ інваріанти виконано');
      return;
    }
    for (const f of this.failures) console.log(`✗ порушено: ${f}`);
    process.exitCode = 1;
  }
}

/**
 * Невинесені рядки outbox, що лишились до прогону: замовлення з demo:race і
 * demo:retry (#14), з POST /v1/orders без relay, з обірваного демо. Без цього
 * relay демо виносив би й їх, а споживач рахував би чужі доставки.
 *
 * Виносить їх той самий relayBatch — без споживача, — а потім робоча черга
 * чиститься так само, як її чистить resetQueues. Стан після: outbox без
 * невинесених, черга порожня. Повертає, скільки рядків винесено.
 */
export async function flushOutbox(dataSource: DataSource, broker: Broker): Promise<number> {
  const published = await relayUntilEmpty(dataSource, broker);
  if (published.length > 0) await broker.ch.purgeQueue(LOYALTY_QUEUE);
  return published.length;
}

/** relayBatch, поки є що виносити. Повертає винесені id. */
export async function relayUntilEmpty(dataSource: DataSource, broker: Broker): Promise<string[]> {
  const publisher = new EventPublisher(async () => broker.url);
  const published: string[] = [];
  try {
    for (;;) {
      const batch = await relayBatch(dataSource, publisher);
      if (batch.failed) throw new Error(`relay не виніс ${batch.failed.id}: ${batch.failed.error}`);
      published.push(...batch.published);
      if (batch.claimed === 0) return published;
    }
  } finally {
    await publisher.close();
  }
}

/**
 * Схема — тими самими міграціями, що `npm run migrate`. Демо #22 запускаються
 * на свіжій базі без окремого кроку: застосовані міграції TypeORM пропускає,
 * тож повторний виклик нічого не змінює.
 */
export async function migrate(dataSource: DataSource): Promise<number> {
  return (await dataSource.runMigrations()).length;
}

/** Рядки outbox цих замовлень: скільки є, скільки винесено, сума закомічених спроб. */
export async function outboxOf(dataSource: DataSource, orderIds: string[]): Promise<{ rows: number; published: number; attempts: number }> {
  const [row] = await dataSource.query(
    `SELECT count(*)::int AS rows, count(published_at)::int AS published, COALESCE(sum(attempts), 0)::int AS attempts
       FROM outbox
      WHERE aggregate_type = $1 AND aggregate_id = ANY($2::text[])`,
    [ORDER_AGGREGATE, orderIds],
  );
  return { rows: row.rows, published: row.published, attempts: row.attempts };
}

/** Позначки inbox споживача балів для цих подій. */
export async function processedOf(dataSource: DataSource, eventIds: string[]): Promise<number> {
  const [row] = await dataSource.query(
    `SELECT count(*)::int AS n FROM processed_messages WHERE consumer = $1 AND message_id = ANY($2::uuid[])`,
    [LOYALTY_QUEUE, eventIds],
  );
  return row.n;
}
