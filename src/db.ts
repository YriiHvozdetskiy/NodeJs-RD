import pg from 'pg';

// Конфіг приходить із оточення, а не з файлу в образі (12-factor).
// Той самий образ їде в dev, CI і прод — різниця лише в env.
const connectionString = process.env.DATABASE_URL;

// Пул створюється ОДИН раз на процес і живе стільки ж, скільки процес.
// Тому його треба закривати у graceful shutdown — див. src/server.ts.
export const pool = connectionString
  ? new pg.Pool({
      connectionString,
      max: 10, // Postgres за замовчуванням тримає 100 конектів на весь кластер
      connectionTimeoutMillis: 5_000,
    })
  : null;

export interface User {
  id: number;
  email: string;
  created_at: Date;
}

export async function findUsers(): Promise<User[]> {
  if (!pool) throw new Error('DATABASE_URL не задано');

  const { rows } = await pool.query<User>(
    'select id, email, created_at from users order by id',
  );
  return rows;
}
