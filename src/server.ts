import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { pool, findUsers } from './db.ts';

const PORT = Number(process.env.PORT ?? 3000);

const app = express();

// Лог у stdout одним рядком JSON. У контейнері це єдиний правильний приймач:
// потік підбирає docker/k8s, застосунок не пише у файли і не крутить ротацію.
app.use((req: Request, res: Response, next: NextFunction) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(
      JSON.stringify({
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        ms: Number(ms.toFixed(1)),
      }),
    );
  });

  next();
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

// Діагностична сторінка: показує, ким саме працює процес усередині контейнера.
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'hw-05-docker',
    hostname: process.env.HOSTNAME ?? 'невідомо', // id контейнера
    uid: process.getuid?.() ?? -1, // 0 означало б root — саме цього уникаємо
    node: process.version,
    db: pool ? 'налаштована' : 'не налаштована',
  });
});

app.get('/users', async (_req: Request, res: Response) => {
  if (!pool) {
    res.status(503).json({ error: 'DATABASE_URL не задано' });
    return;
  }

  // Express 5 сам ловить reject з async-хендлера і веде його в error middleware
  // нижче. В Express 4 цей самий код підвісив би запит до таймауту.
  const users = await findUsers();
  res.json(users);
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(JSON.stringify({ level: 'error', error: String(error) }));
  res.status(503).json({ error: 'база недоступна' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  // host '0.0.0.0', а не дефолт: localhost усередині контейнера — це сам
  // контейнер, і жоден запит ззовні до нього не дійде.
  console.log(JSON.stringify({ msg: `слухаю :${PORT}`, uid: process.getuid?.() }));
});

// docker compose down шле SIGTERM у PID 1 і чекає 10 секунд, перш ніж SIGKILL.
// Без цього блоку кожна зупинка стеку коштує ті самі 10 секунд.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.log(JSON.stringify({ msg: `${signal} — закриваюсь коректно` }));

    // close() перестає приймати нові з'єднання, але чекає на відкриті.
    // Keep-alive конекти простоюють хвилинами — closeIdleConnections()
    // рубає саме їх, не чіпаючи запити, які зараз обробляються.
    server.closeIdleConnections();
    server.close(async () => {
      await pool?.end();
      process.exit(0);
    });
  });
}
