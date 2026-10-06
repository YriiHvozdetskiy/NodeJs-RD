import type { Pool, PoolClient } from 'pg';

/**
 * Ізоляція через ROLLBACK: кожен тест живе всередині BEGIN на одному
 * з'єднанні, і afterEach відкочує все, що тест записав. Таблиці на старті
 * кожного тесту — рівно такі, як після міграцій.
 *
 * Повертає не клієнт, а функцію: сам клієнт з'являється лише в beforeEach.
 * Репозиторій отримує його як `Queryable` — саме тому репозиторії приймають
 * «щось із query()», а не пул.
 *
 * Межа стратегії: код, який відкриває власну транзакцію на іншому з'єднанні
 * (checkout через TypeORM, застосунок у E2E), у цей BEGIN не потрапить.
 */
export function rollbackEachTest(pool: () => Pool): () => PoolClient {
  let client: PoolClient | undefined;

  beforeEach(async () => {
    client = await pool().connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (!client) return;
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
      client = undefined;
    }
  });

  return () => {
    if (!client) throw new Error('rollbackEachTest: клієнт існує лише всередині тесту');
    return client;
  };
}
