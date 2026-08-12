-- Postgres виконує все з /docker-entrypoint-initdb.d/ РІВНО ОДИН РАЗ —
-- при першій ініціалізації порожнього тому даних.
--
-- Саме тому цей файл ще й ілюструє AC про persistence:
--   docker compose down     → том лишається → цей скрипт більше не запуститься
--   docker compose down -v  → том знищено   → наступний up виконає його наново

create table if not exists users (
  id         serial primary key,
  email      text        not null unique,
  created_at timestamptz not null default now()
);

insert into users (email) values
  ('ada@example.com'),
  ('grace@example.com'),
  ('linus@example.com')
on conflict (email) do nothing;
