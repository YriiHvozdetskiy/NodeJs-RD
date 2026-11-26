import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { DataSource } from 'typeorm';
import { createUser, type DemoUser } from '../auth/demo-kit';

/**
 * Спільне для demo:logs, demo:metrics і demo:trace (#29). Кожне демо:
 *   1. чистить свої хвости, накочує міграції, створює покупця з замовленням;
 *   2. піднімає застосунок ОКРЕМИМ процесом (src/demo-obs-pod.ts) і збирає
 *      його stdout рядок за рядком;
 *   3. шле запити з власним `traceparent`, рахує числа з логу, /metrics і
 *      Tempo, друкує ключ=число і саме перевіряє інваріанти — код виходу.
 *
 * Числа рахуються, а не друкуються: лог групується за trace_id, лічильник —
 * різниця двох скрейпів, спани — відповідь бека трейсів.
 */

export const DEMO_ROUTE = '/v1/orders/:orderId';

// ─── W3C Trace Context ────────────────────────────────────────────────────

export interface TraceParent {
  /** `00-<32 hex trace-id>-<16 hex parent-id>-01` — те, що йде в заголовок. */
  header: string;
  traceId: string;
  /** span-id спана клієнта, який «викликав» сервіс; у трейсі спана з таким id немає. */
  parentId: string;
}

/** Новий `traceparent` з прапорцем 01 (sampled): сервіс записує трейс, а не лише передає id. */
export function traceparent(): TraceParent {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return { header: `00-${traceId}-${parentId}-01`, traceId, parentId };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────

export interface Reply {
  status: number;
  json: unknown;
  ms: number;
}

export async function request(
  url: string,
  options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const started = performance.now();
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  const ms = performance.now() - started;
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, ms };
}

function stringField(source: unknown, key: string): string | undefined {
  const value = typeof source === 'object' && source !== null ? Reflect.get(source, key) : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** access_token з відповіді login; не той формат — порожній рядок, і наступні запити дадуть 401. */
export function accessTokenOf(reply: Reply): string {
  return stringField(reply.json, 'access_token') ?? '';
}

// ─── Лог пода ─────────────────────────────────────────────────────────────

/** Рядок stdout застосунку: сирий текст і, якщо це JSON-обʼєкт, його поля. */
export interface LogLine {
  raw: string;
  json: Record<string, unknown> | null;
}

function parseLine(raw: string): LogLine {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return { raw, json: Object.fromEntries(Object.entries(value)) };
    }
  } catch {
    // не JSON — так і запишемо
  }
  return { raw, json: null };
}

export function str(line: LogLine, key: string): string | undefined {
  return stringField(line.json, key);
}

/** Рядок логу доступу — останній у історії кожного запиту (src/observability/http-observability.ts). */
export function isAccessLine(line: LogLine): boolean {
  return str(line, 'layer') === 'http' && str(line, 'msg') === 'request completed';
}

interface PodReady {
  t: 'ready';
  url: string;
}

function isReady(m: unknown): m is PodReady {
  return typeof m === 'object' && m !== null && 't' in m && m.t === 'ready' && 'url' in m && typeof m.url === 'string';
}

function isFlushed(m: unknown): boolean {
  return typeof m === 'object' && m !== null && 't' in m && m.t === 'flushed';
}

/**
 * Застосунок окремим процесом: stdout — у пам'ять демо, рядок за рядком.
 * stderr не перехоплюється: падіння пода видно в терміналі як є.
 */
export class ObsPod {
  readonly lines: LogLine[] = [];
  private tail = '';

  private constructor(
    private readonly proc: ChildProcess,
    readonly url: string,
  ) {}

  static start(timeoutMs = 30_000): Promise<ObsPod> {
    const proc = fork(path.join(__dirname, '..', 'demo-obs-pod.js'), {
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    });
    const collected: string[] = [];
    let pod: ObsPod | undefined;
    let tail = '';
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      if (pod) return pod.feed(chunk);
      // До `ready` рядки складаються окремо: обʼєкта пода ще немає.
      const parts = (tail + chunk).split('\n');
      tail = parts.pop() ?? '';
      collected.push(...parts.filter((p) => p !== ''));
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`застосунок демо не стартував за ${timeoutMs} мс`));
      }, timeoutMs);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`застосунок демо вийшов з кодом ${code} до готовності:\n${collected.join('\n')}`));
      });
      proc.on('message', (m) => {
        if (!isReady(m)) return;
        clearTimeout(timer);
        proc.removeAllListeners('exit');
        pod = new ObsPod(proc, m.url);
        pod.lines.push(...collected.map(parseLine));
        pod.feed(tail);
        resolve(pod);
      });
    });
  }

  private feed(chunk: string): void {
    const parts = (this.tail + chunk).split('\n');
    this.tail = parts.pop() ?? '';
    for (const part of parts) if (part !== '') this.lines.push(parseLine(part));
  }

  /** Позиція в лозі «зараз»: усе, що прийде після, — історія наступних запитів. */
  mark(): number {
    return this.lines.length;
  }

  since(mark: number): LogLine[] {
    return this.lines.slice(mark);
  }

  /**
   * Дочекатись рядків логу доступу для кожного з trace_id. Відповідь клієнт
   * отримує РАНІШЕ, ніж застосунок пише цей рядок (він пишеться на `close`
   * сокета), тож без очікування демо рахувало б недописаний лог.
   */
  async waitForAccess(traceIds: string[], timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const missing = (): string[] => {
      const seen = new Set(this.lines.filter(isAccessLine).map((line) => str(line, 'trace_id')));
      return traceIds.filter((id) => !seen.has(id));
    };
    while (missing().length > 0) {
      if (Date.now() > deadline) throw new Error(`немає рядка логу доступу для ${missing().join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** forceFlush() експортера спанів у поді: після відповіді `flushed` спани вже пішли в OTLP. */
  flush(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`flush спанів не відповів за ${timeoutMs} мс`)), timeoutMs);
      const onMessage = (m: unknown): void => {
        if (!isFlushed(m)) return;
        clearTimeout(timer);
        this.proc.off('message', onMessage);
        const error = stringField(m, 'error');
        if (error) reject(new Error(`flush спанів: ${error}`));
        else resolve();
      };
      this.proc.on('message', onMessage);
      this.proc.send({ t: 'flush' });
    });
  }

  /** SIGTERM і очікування виходу: після цього в `lines` увесь stdout процесу. */
  async stop(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.proc.once('exit', () => resolve()));
    // Вихід процесу і кінець його stdout — дві різні події: без другої останні
    // рядки (лог зупинки) ще могли б бути в дорозі.
    const drained = new Promise<void>((resolve) => {
      if (this.proc.stdout) this.proc.stdout.once('end', () => resolve());
      else resolve();
    });
    this.proc.kill('SIGTERM');
    const forced = setTimeout(() => this.proc.kill('SIGKILL'), 10_000);
    await Promise.all([exited, drained]);
    clearTimeout(forced);
    this.feed('\n');
  }
}

// ─── Текст /metrics ───────────────────────────────────────────────────────

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Розібрати експозицію Prometheus: `name{k="v",…} value` → { name, labels, value }. */
export function parseExposition(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)})?\s+(\S+)$/.exec(line);
    if (!match) continue;
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[pair[1] ?? ''] = pair[2] ?? '';
    }
    samples.push({ name: match[1] ?? '', labels, value: Number(match[3]) });
  }
  return samples;
}

export async function scrape(podUrl: string): Promise<Sample[]> {
  const res = await fetch(`${podUrl}/metrics`);
  if (res.status !== 200) throw new Error(`/metrics відповів ${res.status}`);
  return parseExposition(await res.text());
}

export function sum(samples: Sample[], name: string, where: (labels: Record<string, string>) => boolean = () => true): number {
  return samples.filter((s) => s.name === name && where(s.labels)).reduce((acc, s) => acc + s.value, 0);
}

// ─── Дані демо ────────────────────────────────────────────────────────────

/**
 * Покупець і його замовлення — SQL-ом, як arrange-фаза в demo:rbac (#24):
 * чекаут і outbox тут ні до чого. Продавець потрібен, бо товар має власника.
 */
export async function buyerWithOrder(dataSource: DataSource, demo: string): Promise<{ buyer: DemoUser; orderId: string }> {
  const seller = await createUser(dataSource, demo, 'seller', 'seller');
  const buyer = await createUser(dataSource, demo, 'buyer', 'buyer');
  const price = 12_500;
  const [product]: { id: string }[] = await dataSource.query(
    `INSERT INTO products (seller_id, category, title, price_cents, stock) VALUES ($1, 'books', 'Демо-книга #29', $2, 5) RETURNING id`,
    [seller.id, price],
  );
  const [order]: { id: string }[] = await dataSource.query(
    `INSERT INTO orders (buyer_id, region, status, currency, subtotal_cents, discount_cents, total_cents)
     VALUES ($1, 'UA', 'pending', 'UAH', $2, 0, $2) RETURNING id`,
    [buyer.id, price],
  );
  await dataSource.query(`INSERT INTO order_items (order_id, product_id, qty, unit_price_cents) VALUES ($1, $2, 1, $3)`, [
    order.id,
    product.id,
    price,
  ]);
  return { buyer, orderId: order.id };
}

/** Логін покупця; access-токен — для всіх запитів демо. */
export async function loginAs(pod: ObsPod, user: DemoUser): Promise<string> {
  const reply = await request(`${pod.url}/v1/auth/login`, { method: 'POST', body: { email: user.email, password: user.password } });
  const token = accessTokenOf(reply);
  if (reply.status !== 200 || !token) throw new Error(`логін демо-покупця: ${reply.status}`);
  return token;
}
