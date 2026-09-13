# Оптимізація запитів: EXPLAIN до і після

Середовище: PostgreSQL 17.11 (`postgres:17-alpine`, aarch64), Docker Desktop на
Apple Silicon. Усі плани з одного прогону `scripts/db-bench.sh` на чистому томі
в тому самому порядку, що й у грейдера: `schema.sql` → `seed.sql` → EXPLAIN «до»
→ `indexes.sql` → `ANALYZE` → EXPLAIN «після». Для «після» кожен запит виконано
тричі й узято третій план: перший після `CREATE INDEX` іде по холодному кешу.

Обсяг після `seed.sql`:

| Таблиця | Рядків | Heap | Перекіс |
| --- | --- | --- | --- |
| `orders` | 200 000 | 25 MB | статуси paid 90.0 % · pending 6.0 % · cancelled 4.0 %; регіони UA 80 % · EU 12 % · US 6 % · CN 2 % |
| `products` | 120 000 | 91 MB | 40 іменників × 20 прикметників українською; q4 знаходить 149 рядків = 0.12 % |
| `users` | 50 000 | 6.9 MB | 5 admin · 2 000 seller · решта buyer; email у трьох варіантах регістру |
| `order_items` | 386 399 | | половина замовлень з однією позицією, максимум чотири |

Як читати плани. `Buffers: shared hit` — скільки сторінок по 8 КБ запит підняв
із кешу, `read` — скільки довелось читати з диска. Мілісекунди залежать від
машини й від того, чи прогрітий кеш; buffers залежать лише від структури даних
і плану, тому порівнюю насамперед їх.

## q1 — замовлення покупця за період

Запит `GET /orders` покупця: перша сторінка keyset-пагінації, найновіші спершу,
tie-breaker по `id` той самий, що в курсорі (`src/common/cursor.ts`).

```sql
SELECT id, status, total, currency, created_at
FROM orders
WHERE buyer_id = 137
  AND created_at >= now() - interval '180 days'
ORDER BY created_at DESC, id DESC
LIMIT 20
```

### До

```
 Limit  (cost=5809.88..5809.88 rows=2 width=33) (actual time=7.470..9.067 rows=4 loops=1)
   Buffers: shared hit=3149
   ->  Sort  (cost=5809.88..5809.88 rows=2 width=33) (actual time=7.469..9.064 rows=4 loops=1)
         Sort Key: created_at DESC, id DESC
         Sort Method: quicksort  Memory: 25kB
         Buffers: shared hit=3149
         ->  Gather  (cost=1000.00..5809.87 rows=2 width=33) (actual time=1.134..9.036 rows=4 loops=1)
               Workers Planned: 2
               Workers Launched: 2
               Buffers: shared hit=3143
               ->  Parallel Seq Scan on orders  (cost=0.00..4809.67 rows=1 width=33) (actual time=2.022..5.615 rows=1 loops=3)
                     Filter: ((buyer_id = 137) AND (created_at >= (now() - '180 days'::interval)))
                     Rows Removed by Filter: 66665
                     Buffers: shared hit=3143
 Planning:
   Buffers: shared hit=100 read=1 written=1
 Planning Time: 0.395 ms
 Execution Time: 9.107 ms
```

### Після

```
 Limit  (cost=0.42..12.46 rows=2 width=33) (actual time=0.032..0.046 rows=4 loops=1)
   Buffers: shared hit=11
   ->  Index Scan Backward using idx_orders_buyer_created on orders  (cost=0.42..12.46 rows=2 width=33) (actual time=0.031..0.044 rows=4 loops=1)
         Index Cond: ((buyer_id = 137) AND (created_at >= (now() - '180 days'::interval)))
         Buffers: shared hit=11
 Planning:
   Buffers: shared hit=141
 Planning Time: 0.515 ms
 Execution Time: 0.078 ms
```

Індекс `idx_orders_buyer_created` `(buyer_id, created_at, id)` став вузлом
`Index Scan Backward`. «До» три процеси читали всі 3 143 сторінки таблиці й
відкидали по 66 665 рядків кожен, щоб лишити чотири; «після» обидві умови
пішли в `Index Cond`, і запит торкнувся 11 сторінок. Зникли `Gather`, воркери
й `Sort`: індекс уже впорядкований по `(created_at, id)` усередині одного
`buyer_id`, тож читання задом наперед віддає рядки в порядку `ORDER BY`, і
`LIMIT` зупиняє його після четвертого. Buffers 3 149 → 11, час 9.1 → 0.08 мс.

## q2 — черга «зависших» pending

Фоновий обробник бере неоплачені замовлення старші за 15 хвилин, найстаріші
спершу. `pending` — 6 % таблиці; решта 94 % цьому запиту не потрібні ніколи.

```sql
SELECT id, buyer_id, total, created_at
FROM orders
WHERE status = 'pending'
  AND created_at < now() - interval '15 minutes'
ORDER BY created_at
LIMIT 100
```

### До

```
 Limit  (cost=5995.47..6007.14 rows=100 width=32) (actual time=8.652..10.640 rows=100 loops=1)
   Buffers: shared hit=3217
   ->  Gather Merge  (cost=5995.47..7129.79 rows=9722 width=32) (actual time=8.651..10.631 rows=100 loops=1)
         Workers Planned: 2
         Workers Launched: 2
         Buffers: shared hit=3217
         ->  Sort  (cost=4995.45..5007.60 rows=4861 width=32) (actual time=6.914..6.919 rows=82 loops=3)
               Sort Key: created_at
               Sort Method: top-N heapsort  Memory: 36kB
               Buffers: shared hit=3217
               Worker 0:  Sort Method: top-N heapsort  Memory: 37kB
               Worker 1:  Sort Method: top-N heapsort  Memory: 36kB
               ->  Parallel Seq Scan on orders  (cost=0.00..4809.67 rows=4861 width=32) (actual time=0.007..6.386 rows=3994 loops=3)
                     Filter: ((status = 'pending'::text) AND (created_at < (now() - '00:15:00'::interval)))
                     Rows Removed by Filter: 62673
                     Buffers: shared hit=3143
 Planning:
   Buffers: shared hit=92
 Planning Time: 0.355 ms
 Execution Time: 10.693 ms
```

### Після

```
 Limit  (cost=0.29..107.75 rows=100 width=32) (actual time=0.024..0.333 rows=100 loops=1)
   Buffers: shared hit=102
   ->  Index Scan using idx_orders_pending_created on orders  (cost=0.29..12922.73 rows=12025 width=32) (actual time=0.023..0.324 rows=100 loops=1)
         Index Cond: (created_at < (now() - '00:15:00'::interval))
         Buffers: shared hit=102
 Planning:
   Buffers: shared hit=132
 Planning Time: 0.475 ms
 Execution Time: 0.368 ms
```

Partial-індекс `idx_orders_pending_created` `(created_at) WHERE status = 'pending'`
став вузлом `Index Scan`. В `Index Cond` лишилась тільки умова по `created_at`:
`status = 'pending'` планер довів із предиката індексу й більше не перевіряє
на кожному рядку. Індекс упорядкований по `created_at`, тож `Sort` зник, а
`LIMIT 100` зупинив читання після 100 рядків: 102 сторінки замість 3 217 і
трьох паралельних сортувань. Ціна індексу — 280 кБ на 12 тисяч pending-рядків;
повний індекс по `created_at` на всі 200 тисяч важив би близько 5.4 МБ
(стільки займає `orders_pkey` з ключем того самого розміру), тобто в ~20 разів
більше заради рядків, які запит не читає. Buffers 3 217 → 102, час 10.7 → 0.37 мс.

## q3 — логін без урахування регістру

У базі email лежить так, як його ввели: `User…`, `user…`, `USER…`. Логін
порівнює `lower()` обох сторін, і саме функція над колонкою робить звичайний
індекс по `email` непридатним.

```sql
SELECT id, email, role, created_at
FROM users
WHERE lower(email) = lower('User31337@Example.com')
```

### До

```
 Seq Scan on users  (cost=0.00..1613.00 rows=250 width=43) (actual time=9.759..15.679 rows=1 loops=1)
   Filter: (lower(email) = 'user31337@example.com'::text)
   Rows Removed by Filter: 49999
   Buffers: shared read=863 written=468
 Planning:
   Buffers: shared hit=87
 Planning Time: 0.334 ms
 Execution Time: 15.718 ms
```

### Після

```
 Index Scan using idx_users_email_lower on users  (cost=0.41..8.43 rows=1 width=43) (actual time=0.021..0.022 rows=1 loops=1)
   Index Cond: (lower(email) = 'user31337@example.com'::text)
   Buffers: shared hit=4
 Planning:
   Buffers: shared hit=107
 Planning Time: 0.443 ms
 Execution Time: 0.050 ms
```

Expression-індекс `idx_users_email_lower` `((lower(email)))` став вузлом
`Index Scan`. «До» планер читав усі 863 сторінки `users` і відкидав 49 999
рядків заради одного; він навіть не знав, скільки рядків очікувати
(`rows=250` при факті 1), бо статистики по виразу `lower(email)` у таблиці
немає. Після `CREATE INDEX` + `ANALYZE` статистика по виразу з'явилась разом з
індексом (`rows=1`), і шлях став: корінь → лист → одна сторінка heap, 4 buffers.
`UNIQUE (email)` зі схеми тут не допоміг би нічим: він по `email`, а не по
`lower(email)`. Buffers 863 → 4, час 15.7 → 0.05 мс.

## q4 — пошук по каталогу

Покупець ввів два слова, віддаємо до 20 карток за релевантністю.
`search_vector` — збережена генерована колонка з `db/schema.sql`:
`to_tsvector('simple', title || ' ' || description)`.

```sql
SELECT id, title, ts_rank(search_vector, plainto_tsquery('simple', 'шкіряні кросівки')) AS rank
FROM products
WHERE search_vector @@ plainto_tsquery('simple', 'шкіряні кросівки')
ORDER BY rank DESC, id
LIMIT 20
```

### До

```
 Limit  (cost=13174.19..13174.24 rows=20 width=64) (actual time=32.035..32.038 rows=20 loops=1)
   Buffers: shared hit=8204 read=3475
   ->  Sort  (cost=13174.19..13174.30 rows=41 width=64) (actual time=32.034..32.035 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 27kB
         Buffers: shared hit=8204 read=3475
         ->  Seq Scan on products  (cost=0.00..13173.10 rows=41 width=64) (actual time=1.284..31.965 rows=149 loops=1)
               Filter: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Rows Removed by Filter: 119851
               Buffers: shared hit=8198 read=3475
 Planning:
   Buffers: shared hit=113 read=15
 Planning Time: 0.659 ms
 Execution Time: 32.077 ms
```

### Після

```
 Limit  (cost=176.37..176.42 rows=20 width=64) (actual time=0.644..0.647 rows=20 loops=1)
   Buffers: shared hit=161
   ->  Sort  (cost=176.37..176.47 rows=40 width=64) (actual time=0.643..0.644 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 27kB
         Buffers: shared hit=161
         ->  Bitmap Heap Scan on products  (cost=21.73..175.30 rows=40 width=64) (actual time=0.187..0.600 rows=149 loops=1)
               Recheck Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Heap Blocks: exact=148
               Buffers: shared hit=155
               ->  Bitmap Index Scan on idx_products_search_vector  (cost=0.00..21.72 rows=40 width=0) (actual time=0.167..0.167 rows=149 loops=1)
                     Index Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                     Buffers: shared hit=7
 Planning:
   Buffers: shared hit=153
 Planning Time: 0.671 ms
 Execution Time: 0.717 ms
```

GIN-індекс `idx_products_search_vector` став вузлом `Bitmap Index Scan`. «До»
`Seq Scan` читав усі 11 673 сторінки `products` (91 МБ, бо tsvector лежить у
кожному рядку) і перевіряв `@@` на 120 тисячах векторів заради 149 збігів.
«Після» 7 сторінок GIN віддали список із 149 покажчиків на рядки, `Bitmap Heap
Scan` підняв рівно ті 148 сторінок heap, де ці рядки лежать (`Heap Blocks:
exact=148`, товари розкидані по таблиці, тому майже один блок на рядок).
`Recheck Cond` у плані лишається завжди: GIN у загальному випадку може віддати
зайвих кандидатів, тут не віддав жодного. `Sort` по `ts_rank` нікуди не подівся
й не подінеться: індекс уміє відповісти «які рядки», але не «в якому порядку
за релевантністю»; на 149 рядках це дешево, на 30 % каталогу було б дорого, і
саме тому слова запиту підібрані так, щоб збігів було 0.12 %. Buffers
11 679 → 161, час 32 → 0.7 мс.

## Ціна tsvector-колонки

Заміряно на тих самих 120 000 товарах: копія `products` без `search_vector`
займає 45 МБ heap, з колонкою — 91 МБ, тобто рівно вдвічі; GIN-індекс поверх
неї — ще 5.6 МБ. Плюс кожен `INSERT`/`UPDATE` товару перераховує вектор. Для
каталогу, який читають на порядки частіше, ніж змінюють, це прийнятна ціна;
для таблиці з потоком записів довелося б думати про expression-індекс без
збереженої колонки або окремий пошуковий рушій.

## Мертві індекси

Після всіх чотирьох EXPLAIN «після»:

```sql
SELECT indexrelname FROM pg_stat_user_indexes
WHERE schemaname = 'public' AND idx_scan = 0
  AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conindid <> 0);
-- (0 рядків)
```

| Індекс | Розмір | idx_scan після прогону |
| --- | --- | --- |
| `idx_orders_buyer_created` | 7 944 кБ | 3 |
| `idx_orders_pending_created` | 280 кБ | 3 |
| `idx_users_email_lower` | 2 008 кБ | 3 |
| `idx_products_search_vector` | 5 608 кБ | 5 |

Індекси під PK і UNIQUE у перевірку не входять: вони тримають констрейнт, а
не запити, і `idx_scan = 0` для них нормальний.

## Морфологія

Те саме слово у двох відмінках, той самий конфіг `simple`, та сама база:

```sql
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівки');
-- 3050
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівок');
-- 0
```

Форма «кросівки» дає 3050 збігів, форма «кросівок» — 0, і причина морфології не
стосується зовсім: конфіг `simple` не знає жодної мови, він лише розбиває текст
на слова й приводить їх до нижнього регістру, тож «кросівки» і «кросівок» для
нього дві різні лексеми, які не збігаються посимвольно.

```sql
SELECT to_tsvector('simple', 'Шкіряні кросівки Лелека'), plainto_tsquery('simple', 'кросівок');
-- 'кросівки':2 'лелека':3 'шкіряні':1  |  'кросівок'
```

`SELECT count(*) FROM pg_ts_config` віддає 29 конфігів, `\dF` показує їхній
список: `simple`, `english`, `russian`, `german`, ще два десятки мов, і жодного
`ukrainian`. Вбудовані стемери Postgres це Snowball, а Snowball української не
має. Підмінити `simple` на `russian` не фікс: російський стемер зрізатиме
українські закінчення за чужими правилами, частину слів склеїть, частину
зламає, і результат виглядатиме як пошук, поки хтось не введе слово, на якому
це видно. Справжні шляхи: словник Hunspell `uk_UA` (лекційна `search-lab`,
крок 05: працює, але індексація дорожчає приблизно в 13 разів) або окремий
пошуковий рушій з українською морфологією, це тема #15. Для цього ДЗ висновок
один: пошук по каталогу знаходить точну словоформу, і клієнт має це знати.
