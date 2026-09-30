import type { QueryResult, QueryResultRow } from 'pg';

/**
 * «Щось із query()» — усе, що потрібно репозиторію від бази.
 *
 * Під цей тип підходять три різні речі, і саме тому репозиторій приймає його,
 * а не конкретний клас:
 *   • `DatabaseService` — у застосунку (пул із паролем з файла, #11);
 *   • `pg.Pool` — у тесті, що пише в базу напряму;
 *   • `pg.PoolClient` з відкритим `BEGIN` — у тесті з ізоляцією через ROLLBACK.
 *     Пул роздає кожен запит у довільне з'єднання, тож транзакція, відкрита на
 *     одному, для запиту з іншого просто не існує. Відкотити можна лише те, що
 *     пройшло через те саме з'єднання.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * DI-токен для `Queryable`. Інтерфейс після компіляції зникає, і Nest не має
 * за чим його шукати — потрібен рантайм-ключ. У `DbModule` під ним лежить
 * `DatabaseService`.
 */
export const DB = Symbol('DB');
