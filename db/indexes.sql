-- Мінімальний набір індексів під чотири запити з db/queries/. Кожен має рівно
-- один запит, який його бере; докази — плани «до» і «після» в db/OPTIMIZATIONS.md.
-- Індексів «про запас» немає: pg_stat_user_indexes показав би їх з idx_scan = 0.

-- q1 — замовлення покупця за період, найновіші спершу.
-- Складений: рівність (buyer_id) ліворуч, діапазон (created_at) праворуч, id
-- третім, щоб порядок індексу збігався з ORDER BY created_at DESC, id DESC і
-- планеру не довелося сортувати: Index Scan Backward віддає рядки вже в потрібному порядку.
CREATE INDEX idx_orders_buyer_created ON orders (buyer_id, created_at, id);

-- q2 — черга «зависших» pending. Partial: індексуються лише 6 % рядків, які
-- запит узагалі читає; повний індекс по status був би марним через низьку
-- selectivity значення 'paid', а по (status, created_at) — у 15 разів більшим.
CREATE INDEX idx_orders_pending_created ON orders (created_at) WHERE status = 'pending';

-- q3 — логін без урахування регістру. Expression: у WHERE стоїть lower(email),
-- тож індекс мусить бути по тому самому виразу, індекс по колонці email
-- планер тут не візьме.
CREATE INDEX idx_users_email_lower ON users ((lower(email)));

-- q4 — повнотекстовий пошук по каталогу. GIN по tsvector: інвертований список
-- «слово → рядки», B-tree для оператора @@ не існує. Перший запит після
-- створення холодний, індекс ще не в кеші — дивитись треба на другий-третій прогін.
CREATE INDEX idx_products_search_vector ON products USING GIN (search_vector);
