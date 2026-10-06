import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import type { DataSource } from 'typeorm';
import type { ConsumerReport } from '../consumer';
import { requiredEnv } from '../db/cli-env';
import { CENTS_PER_POINT } from '../loyalty/points-accrual';
import { assertLoyaltyTopology, LOYALTY_DLQ, LOYALTY_QUEUE } from './topology';

/**
 * Спільне для demo:publish, demo:dlq і demo:duplicate. Кожне демо:
 *   1. приводить стан до чистого — топологія, порожня робоча черга (DLQ — лише
 *      demo:dlq, див. resetQueues);
 *   2. запускає СПРАВЖНІЙ споживач (dist/consumer.js) окремим процесом;
 *   3. друкує підсумок рядками ключ=значення;
 *   4. сам перевіряє інваріант і виходить із кодом ≠ 0, якщо той порушено.
 */

/** Споживач у власному процесі — щоб його можна було вбити по-справжньому. */
export class ConsumerProcess {
  readonly reports: ConsumerReport[] = [];
  private readonly proc: ChildProcess;
  private readonly exited: Promise<void>;

  constructor(env: Record<string, string> = {}) {
    this.proc = fork(path.join(__dirname, '..', 'consumer.js'), {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.proc.on('message', (m) => {
      if (isReport(m)) this.reports.push(m);
    });
    this.exited = new Promise((resolve) => this.proc.once('exit', () => resolve()));
  }

  count(t: ConsumerReport['t']): number {
    return this.reports.filter((r) => r.t === t).length;
  }

  of<T extends ConsumerReport['t']>(t: T): Extract<ConsumerReport, { t: T }>[] {
    return this.reports.filter((r): r is Extract<ConsumerReport, { t: T }> => r.t === t);
  }

  /** Дочекатись стану, а не поспати навмання. Упав процес — чекати нема на що. */
  async until(what: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (this.proc.exitCode !== null) throw new Error(`споживач вийшов (код ${this.proc.exitCode}), не дочекавшись: ${what}`);
      if (Date.now() > deadline) throw new Error(`не дочекались за ${timeoutMs} мс: ${what}`);
      await sleep(20);
    }
  }

  ready(): Promise<void> {
    return this.until('споживач підписався', () => this.count('ready') > 0);
  }

  get prefetch(): number {
    return this.of('ready')[0]?.prefetch ?? 0;
  }

  /**
   * SIGKILL — не SIGTERM і не channel.close(). Коректне закриття — це фрейм
   * channel.close, і брокер повертає незасвідчене навмисно. Падіння в проді
   * виглядає інакше: процес зникає, ОС закриває сокет, брокер бачить обрив.
   */
  async kill(): Promise<void> {
    this.proc.kill('SIGKILL');
    await this.exited;
  }

  /** SIGTERM — коректне завершення: відписатись, доробити, закрити канал. */
  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    this.proc.kill('SIGTERM');
    const forced = setTimeout(() => this.proc.kill('SIGKILL'), 5_000);
    await this.exited;
    clearTimeout(forced);
  }
}

function isReport(m: unknown): m is ConsumerReport {
  return typeof m === 'object' && m !== null && 't' in m;
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
