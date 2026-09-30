import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import dataSource from './data-source';
import { Order, OrderItem, Payment, PointsEntry, Product, Promotion, User } from './entities';
import * as data from './seed-data';

/**
 * Детермінований ідемпотентний seed: `npm run seed && npm run seed` дає ту
 * саму кількість рядків, другий запуск нічого не вставляє і не падає.
 *
 * Як досягнуто ідемпотентності: у кожного рядка сіду фіксований id, а INSERT
 * іде з ON CONFLICT DO NOTHING — повторний рядок б'ється об PK (або об UNIQUE
 * email / order_id / code) і тихо пропускається.
 *
 * Чому не repository.save(): id у схемі — GENERATED ALWAYS AS IDENTITY, і
 * Postgres відкидає явне значення з «cannot insert a non-DEFAULT value into
 * column "id"», поки INSERT не скаже OVERRIDING SYSTEM VALUE. У TypeORM
 * такого модифікатора немає ні в Repository, ні в QueryBuilder. Тому SQL
 * будується тут, але з метаданих entity: назви таблиць і колонок беруться з
 * декораторів, тож перейменування поля в entity не розсинхронізує сід.
 *
 * Уся заливка — одна транзакція: або всі сім таблиць, або жодної.
 */
async function insertFixed<T extends ObjectLiteral>(
  manager: EntityManager,
  target: EntityTarget<T>,
  rows: Partial<T>[],
): Promise<number> {
  const meta = manager.connection.getMetadata(target);
  const columns = Object.keys(rows[0]).map((property) => {
    const column = meta.findColumnWithPropertyName(property);
    if (!column) throw new Error(`${meta.name}: немає колонки для поля «${property}»`);
    return column;
  });

  const params: unknown[] = [];
  const tuples = rows.map(
    (row) => `(${columns.map((c) => `$${params.push(row[c.propertyName as keyof T])}`).join(', ')})`,
  );
  // OVERRIDING SYSTEM VALUE потрібен лише там, де є GENERATED ALWAYS (order_items id не має).
  const hasIdentity = meta.columns.some((c) => c.generatedIdentity === 'ALWAYS');

  const inserted: unknown[] = await manager.query(
    `INSERT INTO "${meta.tableName}" (${columns.map((c) => `"${c.databaseName}"`).join(', ')})
     ${hasIdentity ? 'OVERRIDING SYSTEM VALUE' : ''}
     VALUES ${tuples.join(', ')}
     ON CONFLICT DO NOTHING
     RETURNING 1`,
    params,
  );

  // Лічильник identity нічого не знає про id, вставлені в обхід нього. Без
  // setval перший же INSERT застосунку отримав би id = 1 і впав на PK.
  if (hasIdentity) {
    await manager.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), (SELECT max(id) FROM "${meta.tableName}"))`,
      [meta.tableName],
    );
  }
  return inserted.length;
}

async function main() {
  await dataSource.initialize();
  try {
    // Порядок диктують FK: батьки раніше за дітей.
    const plan: [EntityTarget<ObjectLiteral>, ObjectLiteral[]][] = [
      [User, data.users],
      [Product, data.products],
      [Promotion, data.promotions],
      [Order, data.orders],
      [OrderItem, data.orderItems],
      [Payment, data.payments],
      [PointsEntry, data.pointsEntries],
    ];

    const report = await dataSource.transaction(async (manager) => {
      const rows: { table: string; inserted: number; total: number }[] = [];
      for (const [target, seedRows] of plan) {
        const inserted = await insertFixed(manager, target, seedRows);
        const table = manager.connection.getMetadata(target).tableName;
        const [{ count }] = await manager.query(`SELECT count(*)::int AS count FROM "${table}"`);
        rows.push({ table, inserted, total: count });
      }
      return rows;
    });

    console.table(report);
    const insertedTotal = report.reduce((sum, r) => sum + r.inserted, 0);
    console.log(insertedTotal === 0 ? 'Seed уже застосовано — нових рядків немає.' : `Вставлено рядків: ${insertedTotal}.`);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
