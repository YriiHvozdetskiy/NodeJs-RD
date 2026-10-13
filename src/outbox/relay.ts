import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSource } from 'typeorm';
import { sql } from '../db/sql';
import type { MessageSender } from '../messaging/publisher';

/**
 * Relay transactional outbox (#22): виносить у брокер події, які checkout
 * записав у таблицю outbox тим самим COMMIT, що й замовлення.
 *
 * Один прохід — три коротких коміти навколо мережевих викликів:
 *
 *   1. оренда   SELECT … WHERE published_at IS NULL AND оренда вільна
 *               ORDER BY created_at, id LIMIT n FOR UPDATE SKIP LOCKED
 *               → UPDATE locked_until = зараз + RELAY_LEASE_MS → COMMIT
 *   2. на кожен рядок: UPDATE attempts + 1 → COMMIT → publish
 *   3. позначка UPDATE published_at → COMMIT
 *
 * SKIP LOCKED, а не голий FOR UPDATE: кілька relay (вбудований у кожен інстанс
 * API плюс `npm run relay`) беруть оренду паралельно, не чекаючи одне одного й
 * не беручи той самий рядок. Голий FOR UPDATE дав би ті самі 0 дублів ціною
 * нуля паралельності — другий relay стояв би на локу першого.
 *
 * Чому оренда, а не лок рядка на весь прохід. Лок живе, поки відкрита
 * транзакція, і все, що вона записала, — разом із `attempts + 1` — зникає,
 * якщо relay помер до COMMIT. Спроба, убита разом із процесом, не лишала б
 * сліду, і алерт на `attempts` її б не побачив (ревʼю #22). Оренда — колонка, а
 * не лок: вона закомічена, тож `attempts + 1` можна закомітити ДО publish
 * окремим оператором — рядок ніхто не тримає, а інші relay його не беруть, бо
 * оренда ще не минула. Relay помер — оренда спливає, і рядок бере наступний.
 *
 * Чому publish ПЕРЕД позначкою. Між ними може статися що завгодно: процес
 * помер, зʼєднання з базою обірвалось. Тоді рядок лишається невинесеним, і
 * після оренди його публікують удруге — ДУБЛЬ. Позначка, закомічена до
 * publish, у тій самій точці дала б «позначено, але не віддано» — ВТРАТУ.
 * Дубль лікує дедуплікація на споживачі, втрату не лікує ніщо. Тому доставка
 * тут at-least-once, і demo:crash-relay показує це навмисним kill -9.
 *
 * Чому `published_at IS NULL`, а не «id більший за останній винесений». Номер
 * рядок отримує на INSERT, а видимим стає на COMMIT: транзакція, що почалась
 * раніше, але закомітилась пізніше, лишила б рядок ПОЗАДУ курсора — і його не
 * винесли б ніколи. Прапорець на самому рядку такої дірки не має.
 *
 * ORDER BY задає порядок ВИБІРКИ, а не доставки: два relay розбирають сусідні
 * рядки одночасно, і подія, створена пізніше, може приїхати раніше. Порядок
 * order.placed споживачу балів не потрібен — кожна подія про своє замовлення.
 */
export const RELAY_BATCH_SIZE = 50;

/**
 * Скільки рядок належить relay, що його взяв. Має перекривати найдовший
 * прохід: 50 publish по мілісекунди плюс CONFIRM_TIMEOUT_MS (5 с) на першій
 * невдачі. Довша оренда — довше чекає рядок, чий relay помер; коротша — більше
 * дублів від relay, що ще живий, але повільний.
 */
export const RELAY_LEASE_MS = 30_000;

/** Пауза, коли невинесених немає. Частковий індекс робить порожній опит дешевим. */
const IDLE_MS = 500;

/** Пауза після збою: base · 2^(n−1), стеля 15 с, із джитером (див. delayAfterFailure). */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 15_000;

/**
 * Оренда одним оператором: вибрати й позначити атомарно. clock_timestamp(), а
 * не now(): оренда рахується від миті захоплення, а не від BEGIN.
 */
const CLAIM = `
  WITH free AS (
    SELECT id
      FROM outbox
     WHERE published_at IS NULL
       AND (locked_until IS NULL OR locked_until < clock_timestamp())
     ORDER BY created_at, id
     LIMIT $1
       FOR UPDATE SKIP LOCKED
  )
  UPDATE outbox o
     SET locked_until = clock_timestamp() + make_interval(secs => $2)
    FROM free
   WHERE o.id = free.id
  RETURNING o.id, o.type, o.payload, o.created_at`;

interface OutboxRow {
  id: string;
  type: string;
  payload: unknown;
  created_at: Date;
}

export interface RelayBatch {
  /** Скільки рядків прохід узяв в оренду. */
  claimed: number;
  /** Опубліковані й позначені published_at. */
  published: string[];
  /** Рядок, на якому publish упав. Прохід на ньому зупинився. */
  failed?: { id: string; error: string };
}

export interface RelayOptions {
  batchSize?: number;
  leaseMs?: number;
}

export async function relayBatch(dataSource: DataSource, sender: MessageSender, options: RelayOptions = {}): Promise<RelayBatch> {
  const { batchSize = RELAY_BATCH_SIZE, leaseMs = RELAY_LEASE_MS } = options;

  // ── 1. оренда ────────────────────────────────────────────────────────────
  // RETURNING порядку не гарантує — сортуємо самі, як у вибірці.
  const rows = (
    await dataSource.transaction('READ COMMITTED', (manager) => sql<OutboxRow>(manager, CLAIM, [batchSize, leaseMs / 1000]))
  ).sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));

  const published: string[] = [];
  let failed: RelayBatch['failed'];
  for (const row of rows) {
    // ── 2. спроба — закомічена ДО publish ────────────────────────────────
    // Помер relay посеред publish — спроба вже в лічильнику. Ціна: спроба, що
    // впала до мережі, теж рахується. Тобто attempts — «почато», а не «дійшло».
    await dataSource.query(`UPDATE outbox SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    try {
      // Рядок їде як є: id → messageId, type → routing key, payload → тіло.
      // created_at — час транзакції checkout, тобто мить події.
      await sender.send({ messageId: row.id, type: row.type, occurredAt: row.created_at, body: row.payload });
      published.push(row.id);
    } catch (err) {
      // Зупинка на першій невдачі, а не «спробувати решту». Лежачий брокер
      // відмовить і решті. А пізніша подія того самого агрегата не має
      // обганяти ранішу, що застрягла.
      failed = { id: row.id, error: err instanceof Error ? err.message : String(err) };
      break;
    }
  }

  // ── 3. позначка — після publish ──────────────────────────────────────────
  // clock_timestamp(): мить позначки, а не початку оператора.
  if (published.length > 0) {
    await dataSource.query(
      `UPDATE outbox SET published_at = clock_timestamp(), locked_until = NULL, last_error = NULL WHERE id = ANY($1::uuid[])`,
      [published],
    );
  }

  // Невинесене — назад одразу, а не через 30 с оренди: упалий рядок (з
  // причиною в last_error, для алерту поруч з attempts) і ті, до яких прохід
  // не дійшов. Невдалий publish МІГ дійти — загубитись міг лише confirm; тоді
  // наступна спроба дасть дубль, і це нормально.
  const unpublished = rows.map((r) => r.id).filter((id) => !published.includes(id));
  if (unpublished.length > 0) {
    await dataSource.query(
      `UPDATE outbox
          SET locked_until = NULL,
              last_error = CASE WHEN id = $2::uuid THEN $3 ELSE last_error END
        WHERE id = ANY($1::uuid[])`,
      [unpublished, failed?.id ?? null, failed?.error ?? null],
    );
  }
  return { claimed: rows.length, published, failed };
}

export interface RelayLoopOptions extends RelayOptions {
  signal: AbortSignal;
  idleMs?: number;
  onBatch?: (batch: RelayBatch) => void;
  /** Прохід не вдався цілком (база) або зупинився на publish (брокер). */
  onError?: (error: string, delayMs: number) => void;
}

/**
 * Опитування до зупинки. Повний прохід — одразу наступний (черга, мабуть, ще
 * не порожня); неповний — пауза IDLE_MS; збій — пауза, що росте.
 *
 * DataSource — функцією: у застосунку пул ледачий (OrmService) і на старті
 * база може ще лежати. Невдале підключення — такий самий збій із паузою.
 */
export async function runRelay(dataSource: () => Promise<DataSource>, sender: MessageSender, options: RelayLoopOptions): Promise<void> {
  const { signal, idleMs = IDLE_MS, batchSize = RELAY_BATCH_SIZE, onBatch, onError } = options;
  let failures = 0;

  while (!signal.aborted) {
    let delayMs = 0;
    try {
      const batch = await relayBatch(await dataSource(), sender, options);
      onBatch?.(batch);
      if (batch.failed) {
        failures += 1;
        delayMs = delayAfterFailure(failures);
        onError?.(`${batch.failed.id}: ${batch.failed.error}`, delayMs);
      } else {
        failures = 0;
        if (batch.claimed < batchSize) delayMs = idleMs;
      }
    } catch (err) {
      failures += 1;
      delayMs = delayAfterFailure(failures);
      // Збій на зупинці (пул уже закривається) — не новина.
      if (!signal.aborted) onError?.(err instanceof Error ? err.message : String(err), delayMs);
    }
    if (delayMs > 0) await sleep(delayMs, undefined, { signal }).catch(() => undefined);
  }
}

/**
 * Equal jitter: половина паузи фіксована, половина випадкова. Брокер, що
 * впав, бачать усі relay одночасно — без джитера вони й повертались би хором.
 * Нижня межа (половина) лишає паузу паузою навіть на невдалому кидку.
 */
function delayAfterFailure(failures: number): number {
  const exp = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}
