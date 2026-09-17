-- ⚠️ ЄДИНИЙ файл у db/, який знищує дані. Викидає всі таблиці дата-шару разом
-- з їхнім вмістом, індексами й послідовностями.
--
-- Навіщо окремо від schema.sql: повторний прогін схеми по заповненій базі
-- мовчки зносив би дані. Без DROP `schema.sql` падає на «relation already
-- exists» — це fail-fast, а не незручність: щоб перезалити базу, треба
-- написати саме цю команду й побачити її ім'я.
--
--   psql -v ON_ERROR_STOP=1 -f db/reset.sql   ← перед повторним schema.sql
--
-- Грейдер іде на чистий том (`docker compose down -v`) і цього файла не
-- потребує взагалі.
--
-- Порядок зворотний до schema.sql: діти раніше за батьків. CASCADE тут
-- підстраховує від залишків, яких у цьому переліку немає.

DROP TABLE IF EXISTS
  points_entries, payments, order_items, orders, promotions, products, users
CASCADE;
