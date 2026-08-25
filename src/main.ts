import 'reflect-metadata';

import { Container } from './container';
import { UsersController } from './controllers/users.controller';
import { createApp } from './dispatcher';
import { collectRoutes } from './router';

const PORT = Number(process.env.PORT ?? 3000);

const controllers = [UsersController];

const container = new Container();
const server = createApp(container, controllers);

server.listen(PORT, () => {
  console.log(`mini-nest слухає http://localhost:${PORT}`);

  // Список друкуємо з ТАБЛИЦІ, а не з рядків у коді — найдешевший спосіб
  // побачити, що маршрути справді зібрані з декораторів.
  for (const route of collectRoutes(controllers)) {
    const guards = route.guards.map((g) => g.name).join(', ');
    const marks = guards === '' ? '' : `  [${guards}]`;
    console.log(`  ${route.method.padEnd(4)} ${route.path}${marks}`);
  }
});
