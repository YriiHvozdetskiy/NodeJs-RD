# Лекція 5 — Docker: Express + Postgres однією командою

Express 5 на TypeScript, запакований у multi-stage образ і піднятий разом із Postgres 17
через `docker compose`. Домашнє завдання до лекції 5 (foundation, 5 балів).

## Запуск

```bash
docker compose up -d
```

Одна команда — і піднімається все: Postgres із іменованим томом, схема з `db/init.sql`,
а слідом api, який дочекався готовності бази. Ніяких правок файлів перед запуском не потрібно.

```bash
curl http://localhost:3000/health   # {"status":"ok","uptime":12}
curl http://localhost:3000/users    # три користувачі з init.sql
curl http://localhost:3000/         # діагностика: uid процесу, id контейнера, версія Node
```

| Команда | Що робить |
|---|---|
| `docker compose up -d` | підняти стек у dev-режимі (bind mount + hot-reload + порт 3000) |
| `docker compose logs -f api` | логи застосунку |
| `docker compose down` | зупинити, **дані зберегти** |
| `docker compose down -v` | зупинити і **знищити том** із даними |

Порт можна перевизначити: `PORT=8080 docker compose up -d` — його читає і сервер,
і `HEALTHCHECK`, тож контейнер лишається `healthy`.

### Запуск без override (CI, прод)

Базовий `docker-compose.yml` не містить жодного пароля, тому сам по собі він
**навмисно не підніметься** — Postgres відмовиться ініціалізуватись із порожнім
`POSTGRES_PASSWORD`. Креденшели треба передати явно:

```bash
cp .env.example .env          # і замінити пароль на справжній
docker compose -f docker-compose.yml up -d
```

У CI те саме роблять секрети раннера — `.env` не потрібен. Перевірити, що база
дійсно не стартує без пароля:

```bash
docker compose -f docker-compose.yml up -d
# db-1 | Error: Database is uninitialized and superuser password is not specified.
```

## Ендпойнти

| Метод | Шлях | Відповідь |
|---|---|---|
| GET | `/health` | `{"status":"ok","uptime":N}` — сюди ж б'є `HEALTHCHECK` з Dockerfile |
| GET | `/users` | список користувачів із Postgres; `503`, якщо база недоступна |
| GET | `/` | діагностика: `uid`, `hostname` контейнера, версія Node, стан БД |

## Розмір образу

| Образ | Як зібраний | Розмір |
|---|---|---|
| `hw05-api` | `Dockerfile` — multi-stage, `node:24-slim`, `npm ci --omit=dev` | **252 MB** |
| `hw05-naive` | `Dockerfile.naive` — одна стадія, повний `node:24`, `npm install` | **1.17 GB** |

Заміряно на `linux/arm64` (Apple Silicon). На `linux/amd64` обидва числа помітно більші —
близько 338 MB проти 1.68 GB, — але співвідношення тримається те саме, ~4.6×.

Відтворити заміри:

```bash
docker build -t hw05-api:local .
docker build -f Dockerfile.naive -t hw05-naive:local .
docker images hw05-api:local hw05-naive:local --format '{{.Repository}} {{.Size}}'
```

**Чому різниця в 4.6 разу:** одностадійний образ назавжди тягне в собі те, що потрібно було
лише під час збірки — базу `node:24` з компіляторами замість `slim`, дев-залежності
(`typescript`, `@types/*`) і вихідні `.ts`, тоді як multi-stage лишає все це у стадії `builder`
і бере з неї виключно скомпільований `dist/`.

Перевірити, що у фінальний образ справді нічого зайвого не потрапило:

```bash
docker run --rm hw05-api:local ls /app
# dist  node_modules  package-lock.json  package.json   ← жодного .ts, жодного tsconfig

docker run --rm hw05-api:local ls node_modules | grep -E '^typescript$|^@types$'
# порожньо (у фіналі 77 пакетів проти повного дерева з dev-залежностями)

docker run --rm hw05-api:local id -u
# 1000 — процес працює не від root
```

## Як перевірялася persistence

Дані Postgres лежать в іменованому томі `pgdata`, тому `docker compose down` їх не чіпає —
знищує їх лише `down -v`. Перевірка:

```bash
# 1. створюємо таблицю і рядок
docker compose exec -T db psql -U app -d app \
  -c "create table persistence_check (id serial primary key, note text);"
docker compose exec -T db psql -U app -d app \
  -c "insert into persistence_check (note) values ('до перезапуску');"

# 2. гасимо стек БЕЗ -v
docker compose down

# 3. піднімаємо наново
docker compose up -d

# 4. таблиця і рядок на місці
docker compose exec -T db psql -U app -d app -c "select * from persistence_check;"
#  id |      note
# ----+----------------
#   1 | до перезапуску
# (1 row)
```

Побічно це підтверджує й `db/init.sql`: Postgres виконує його рівно один раз, при першій
ініціалізації порожнього тому. Після `down` → `up` у таблиці `users` так само три рядки,
а не шість — скрипт удруге не запускався.

## Структура

| Файл | Призначення |
|---|---|
| `Dockerfile` | multi-stage (`builder` → `runner`), non-root, `HEALTHCHECK` |
| `Dockerfile.naive` | навмисно поганий, одностадійний — потрібен лише для порівняння розмірів |
| `.dockerignore` | ріже `node_modules`, `.git`, `dist`, `*.md`, `.env` з контексту збірки |
| `docker-compose.yml` | база: api + postgres, іменований том, `condition: service_healthy`, **без креденшелів** |
| `docker-compose.override.yml` | dev: bind mount на `./src`, hot-reload, порт назовні, локальні креденшели |
| `.env.example` | перелік змінних для запуску без override (CI/прод) |
| `db/init.sql` | схема `users` + сід, виконується при першій ініціалізації тому |
| `src/server.ts` | Express 5: роути, лог у stdout, graceful shutdown |
| `src/db.ts` | пул `pg`, конфіг із `DATABASE_URL` |

## Рішення, які варто пояснити

**Чому дві стадії, а не одна.** `builder` ставить усі залежності і компілює `tsc` → `dist/`.
`runner` починається з чистого `node:24-slim`, ставить залежності наново з `--omit=dev`
і забирає з builder тільки `dist/`. Усе, що наросло під час збірки, лишається в стадії,
яка в результат не їде.

**Чому маніфести копіюються окремо від коду.** Docker кешує шар за хешем його входів.
`package*.json` змінюється раз на тиждень, `src/` — щодня; поставивши встановлення залежностей
вище за код, ми лишаємо його в кеші при кожній правці коду. Порядок в обох стадіях однаковий.

**Чому `USER node`.** За замовчуванням процес у контейнері — root (uid 0). Образ `node:*`
уже містить користувача `node` з uid 1000, тож достатньо перемкнутись. `COPY --chown=node:node`
одразу віддає йому `dist/`.

**Чому `CMD` у exec-формі.** `CMD ["node", "dist/server.js"]` робить node процесом PID 1,
і `SIGTERM` від `docker compose down` приходить прямо в нього. Shell-форма (`CMD npm start`)
підсунула б у PID 1 `/bin/sh`, який сигнал не проксює, — зупинка коштувала б 10 секунд
очікування перед `SIGKILL`. З тієї ж причини в override стоїть `command: ["node", "--watch", ...]`,
а не `npm run dev`. Фактичний час `docker compose down` — **0.66 с**.

**Чому `HEALTHCHECK` б'є через `node -e`.** У `node:24-slim` немає ні `curl`, ні `wget`;
єдиний гарантовано присутній інструмент — сам Node, і його вбудований `fetch`. Порт при
цьому береться з `process.env.PORT`, а не константою: інакше `-e PORT=8080` лишив би
контейнер `unhealthy` назавжди — перевірка стукала б у порт, якого ніхто не слухає.

**Чому образ має тег.** `image: ${IMAGE:-hw05-api}:${TAG:-local}` — без тега docker
підставляє `:latest`, і на спільному раннері, де вже лежить чужий `hw05-api:latest`,
compose узяв би його замість щойно зібраного. Змінні дозволяють CI підставити свій
реєстр і SHA коміту.

**Чому в базовому файлі немає паролів.** `${POSTGRES_PASSWORD:-}` дає порожній рядок,
а не робочий дефолт: на ньому Postgres свідомо відмовляється стартувати, тож CI падає
голосно замість того, щоб тихо піднятись із паролем, який лежить у git. Dev-креденшели
живуть в `docker-compose.override.yml`, якого в CI немає. Healthcheck бази при цьому
читає `"$$POSTGRES_USER"` — подвійний `$` екранує змінну від compose, тож її підставляє
shell усередині контейнера, і перевірка працює однаково, звідки б не прийшли значення.

**Чому в `docker-compose.yml` немає портів і bind-mount.** Базовий файл має лишатися придатним
для CI. Усе, що потрібно тільки розробнику, винесене в `docker-compose.override.yml`,
який compose підхоплює автоматично локально і якого немає в CI-запуску
(`docker compose -f docker-compose.yml ...`).

**Hot-reload без додаткових залежностей.** Node 24 сам зрізає типи з `.ts`, тому
`node --watch src/server.ts` працює прямо в prod-образі з примонтованим `./src` —
ні `tsx`, ні `nodemon`, ні `typescript` у контейнері не потрібні.
