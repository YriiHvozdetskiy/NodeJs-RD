import 'reflect-metadata';

import { Container } from './container';
import { createApp } from './dispatcher';
import { collectRoutes } from './router';
import { UsersController } from './users/users.controller';

const PORT = Number(process.env.PORT ?? 3000);

const controllers = [UsersController];

const container = new Container();
const server = createApp(container, controllers);

server.listen(PORT, () => {
  console.log(`mini-nest слухає http://localhost:${PORT}`);

  // Список друкуємо з ТАБЛИЦІ, а не з рядків у коді. Так само, як його
  // друкує Nest на старті — і це найдешевший спосіб побачити, що маршрути
  // справді зібрані з декораторів, а не переписані руками.
  for (const route of collectRoutes(controllers)) {
    console.log(`  ${route.method.padEnd(4)} ${route.path}`);
  }
});
