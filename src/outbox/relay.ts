import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSource } from 'typeorm';
import { sql } from '../db/sql';
import type { EventPublisher } from '../messaging/publisher';

/**
 * Relay transactional outbox (#22): виносить у брокер події, які checkout
 * записав у таблицю outbox тим самим COMMIT, що й замовлення.
 *
 * Один прохід — одна транзакція, порядок не міняється:
 *
 *   1. SELECT … WHERE published_at IS NULL ORDER BY created_at, id
 *      LIMIT n FOR UPDATE SKIP LOCKED
 *   2. publish кожного рядка (confirm-канал: resolve = брокер узяв)
 *   3. UPDATE published_at — і COMMIT
 *
 * SKIP LOCKED, а не голий FOR UPDATE: кілька relay (вбудований у кожен інстанс
 * API плюс `npm run relay`) розбирають таблицю паралельно, не чекаючи одне
 * одного й не беручи той самий рядок. Голий FOR UPDATE дав би ті самі 0 дублів
 * ціною нуля паралельності — другий relay стояв би на локу першого.
 *
 * Чому publish ПЕРЕД UPDATE. Між ними може статися що завгодно: процес помер,
 * зʼєднання з базою обірвалось, COMMIT не дійшов. Тоді рядок лишається
 * невинесеним, і наступний прохід публікує його вдруге — ДУБЛЬ. Зворотний
 * порядок у тій самій точці дав би «позначено, але не віддано» — ВТРАТУ.
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
 *
 * Ціна підходу: транзакція з локами рядків відкрита на час мережевих викликів.
 * Межа — CONFIRM_TIMEOUT_MS на повідомлення і зупинка проходу на першій
 * невдачі (нижче), тож лежачий брокер тримає лок секунди, а не хвилини.
 */
export const RELAY_BATCH_SIZE = 50;

/** Пауза, коли невинесених немає. Частковий індекс робить порожній опит дешевим. */
const IDLE_MS = 500;

/** Пауза після збою: base · 2^(n−1), стеля 15 с, із джитером (див. delayAfterFailure). */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 15_000;

interface OutboxRow {
  id: string;
  type: string;
  payload: unknown;
  created_at: Date;
}

export interface RelayBatch {
  /** Скільки рядків прохід забрав під лок. */
  claimed: number;
  /** Опубліковані й позначені published_at у цьому COMMIT. */
  published: string[];
  /** Рядок, на якому publish упав. Прохід на ньому зупинився. */
  failed?: { id: string; error: string };
}

export interface RelayOptions {
  batchSize?: number;
  /**
   * Між publish і UPDATE published_at. Лише для demo:crash-relay: туди він
   * кладе паузу й убиває процес — рівно в ту щілину, з якої береться дубль.
   */
  afterPublish?: (ids: string[]) => Promise<void>;
}

export async function relayBatch(dataSource: DataSource, publisher: EventPublisher, options: RelayOptions = {}): Promise<RelayBatch> {
  const { batchSize = RELAY_BATCH_SIZE, afterPublish } = options;

  // dataSource.transaction — одне зʼєднання з пулу на BEGIN … COMMIT. Окремі
  // dataSource.query('BEGIN') і query('COMMIT') могли б поїхати в різні
  // зʼєднання, і «транзакція» була б фікцією, а лок — нічиїм.
  return dataSource.transaction('READ COMMITTED', async (manager) => {
    const rows = await sql<OutboxRow>(
      manager,
      `SELECT id, type, payload, created_at
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at, id
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );

    const published: string[] = [];
    let failed: RelayBatch['failed'];
    for (const row of rows) {
      try {
        // Рядок їде як є: id → messageId, type → routing key, payload → тіло.
        // created_at — час транзакції checkout, тобто мить події.
        await publisher.send({ messageId: row.id, type: row.type, occurredAt: row.created_at, body: row.payload });
        published.push(row.id);
      } catch (err) {
        // Зупинка на першій невдачі, а не «спробувати решту». Лежачий брокер
        // відмовить і решті — лише триматимемо локи довше. А пізніша подія
        // того самого агрегата не має обганяти ранішу, що застрягла.
        failed = { id: row.id, error: err instanceof Error ? err.message : String(err) };
        break;
      }
    }

    if (published.length > 0) {
      await afterPublish?.(published);
      // clock_timestamp(), а не now(): now() — час BEGIN, тобто ДО publish.
      await sql(
        manager,
        `UPDATE outbox
            SET published_at = clock_timestamp(), attempts = attempts + 1, last_error = NULL
          WHERE id = ANY($1::uuid[])`,
        [published],
      );
    }
    if (failed) {
      // Невдача теж комітиться: attempts і last_error — для алерту на рядок,
      // що застряг. Повідомлення при цьому МОГЛО дійти (загубився лише
      // confirm) — тоді наступний прохід дасть дубль, і це нормально.
      await sql(manager, `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [failed.id, failed.error]);
    }
    return { claimed: rows.length, published, failed };
  });
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
export async function runRelay(dataSource: () => Promise<DataSource>, publisher: EventPublisher, options: RelayLoopOptions): Promise<void> {
  const { signal, idleMs = IDLE_MS, batchSize = RELAY_BATCH_SIZE, onBatch, onError } = options;
  let failures = 0;

  while (!signal.aborted) {
    let delayMs = 0;
    try {
      const batch = await relayBatch(await dataSource(), publisher, options);
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
