-- Реалістичний обсяг під EXPLAIN. Наливаю чотири таблиці:
--   users 50 000 · products 120 000 · orders 200 000 · order_items ≈ 380 000.
-- promotions, payments і points_entries лишаються порожніми: їх наповнить
-- бізнес-логіка #14, індексів під них немає, планеру вони поки байдужі.
--
-- Розподіли перекошені навмисно, як у житті: статуси 90/6/4, регіони
-- 80/12/6/2, покупці й продавці — кілька «важких» і довгий хвіст «легких».
-- На рівномірних даних partial-індекс і selectivity не показали б нічого.
--
-- setseed робить наливання відтворюваним: та сама схема + той самий seed
-- дають ті самі рядки, тож числа з db/OPTIMIZATIONS.md можна звірити.
--
-- Ідентифікатори задаю явно (OVERRIDING SYSTEM VALUE), щоб FK у seed
-- посилались на гарантовано існуючі id без зайвих JOIN; наприкінці sequences
-- підтягуються до max(id), інакше перший INSERT застосунку впаде на дублікаті.

SELECT setseed(0.42);

-- ---------------------------------------------------------------------------
-- users: перші 5 — адміни, кожен 25-й — продавець (2 000), решта покупці.
-- Регістр email навмисно мішаний: так вводять люди, і саме це ламає пошук
-- по email без lower() — див. db/queries/q3.sql.
-- ---------------------------------------------------------------------------
INSERT INTO users (id, email, password_hash, role, created_at)
OVERRIDING SYSTEM VALUE
SELECT i,
       CASE i % 3
         WHEN 0 THEN 'User' || i || '@Example.com'
         WHEN 1 THEN 'user' || i || '@example.com'
         ELSE        'USER' || i || '@EXAMPLE.COM'
       END,
       '$argon2id$v=19$m=65536,t=3,p=4$' || md5(i::text),
       CASE
         WHEN i <= 5      THEN 'admin'
         WHEN i % 25 = 0  THEN 'seller'
         ELSE                  'buyer'
       END,
       now() - random() * interval '730 days'
FROM generate_series(1, 50000) AS i;

-- ---------------------------------------------------------------------------
-- products: назва й опис українською, бо пошук q4 і секція «Морфологія»
-- інакше не мають на чому виконатись. Назва = прикметник (узгоджений із родом
-- іменника) + іменник + бренд + артикул; опис — матеріал, колір, призначення.
-- Категорія виводиться з іменника; ціна — з категорії, зі скосом у дешевше.
-- ---------------------------------------------------------------------------
WITH v AS (
  SELECT
    ARRAY['кросівки','черевики','кеди','сандалі','туфлі','чоботи',
          'куртка','футболка','джинси','сукня','светр','пальто','сорочка','штани',
          'ноутбук','смартфон','навушники','планшет','монітор','клавіатура','мишка','колонка',
          'крісло','стіл','лампа','чайник','килим','плед','подушка','дзеркало',
          'велосипед','м''яч','намет','рюкзак','гантелі','скакалка',
          'книга','блокнот','атлас','щоденник']::text[] AS nouns,
    ARRAY['pl','pl','pl','pl','pl','pl',
          'f','f','pl','f','m','n','f','pl',
          'm','m','pl','m','m','f','f','f',
          'n','m','f','m','m','m','f','n',
          'm','m','m','m','pl','f',
          'f','m','m','m']::text[] AS genders,
    ARRAY['Шкіряний','Бавовняний','Бездротовий','Дитячий','Жіночий','Чоловічий','Зимовий','Літній','Спортивний','Класичний',
          'Вінтажний','Ігровий','Компактний','Дерев''яний','Керамічний','Сталевий','Легкий','Теплий','Водонепроникний','Преміальний']::text[] AS adj_m,
    ARRAY['Шкіряна','Бавовняна','Бездротова','Дитяча','Жіноча','Чоловіча','Зимова','Літня','Спортивна','Класична',
          'Вінтажна','Ігрова','Компактна','Дерев''яна','Керамічна','Сталева','Легка','Тепла','Водонепроникна','Преміальна']::text[] AS adj_f,
    ARRAY['Шкіряне','Бавовняне','Бездротове','Дитяче','Жіноче','Чоловіче','Зимове','Літнє','Спортивне','Класичне',
          'Вінтажне','Ігрове','Компактне','Дерев''яне','Керамічне','Сталеве','Легке','Тепле','Водонепроникне','Преміальне']::text[] AS adj_n,
    ARRAY['Шкіряні','Бавовняні','Бездротові','Дитячі','Жіночі','Чоловічі','Зимові','Літні','Спортивні','Класичні',
          'Вінтажні','Ігрові','Компактні','Дерев''яні','Керамічні','Сталеві','Легкі','Теплі','Водонепроникні','Преміальні']::text[] AS adj_pl,
    ARRAY['натуральна шкіра','бавовна','поліестер','алюміній','дерево','кераміка',
          'нержавіюча сталь','замша','вовна','льон','пластик','скло']::text[] AS materials,
    ARRAY['чорний','білий','сірий','синій','червоний','бежевий','зелений','коричневий','жовтий','рожевий']::text[] AS colours,
    ARRAY['бігу','щоденного носіння','подорожей','офісу','дому','спорту','навчання','подарунка','відпочинку','роботи']::text[] AS purposes,
    ARRAY['Карпати','Дніпро','Лелека','Соняшник','Барвінок','Тризуб','Хортиця','Говерла']::text[] AS brands
),
r AS (
  SELECT i,
         floor(random() * 40)::int + 1 AS n,   -- іменник
         floor(random() * 20)::int + 1 AS a,   -- прикметник
         floor(random() * 12)::int + 1 AS m,   -- матеріал
         floor(random() * 10)::int + 1 AS c,   -- колір
         floor(random() * 10)::int + 1 AS p,   -- призначення
         floor(random() * 8)::int  + 1 AS b,   -- бренд
         random() AS r1, random() AS r2, random() AS r3, random() AS r4
  FROM generate_series(1, 120000) AS i
)
INSERT INTO products (id, seller_id, category, title, description, price, stock,
                      rating_avg, rating_count, image_keys, created_at)
OVERRIDING SYSTEM VALUE
SELECT r.i,
       -- продавці — це id, кратні 25; квадрат від random() дає кількох «великих»
       25 * (floor(power(r.r1, 2) * 2000)::int + 1),
       CASE
         WHEN r.n <= 6  THEN 'shoes'
         WHEN r.n <= 14 THEN 'clothing'
         WHEN r.n <= 22 THEN 'electronics'
         WHEN r.n <= 30 THEN 'home'
         WHEN r.n <= 36 THEN 'sports'
         ELSE                'books'
       END,
       CASE v.genders[r.n]
         WHEN 'm' THEN v.adj_m[r.a]
         WHEN 'f' THEN v.adj_f[r.a]
         WHEN 'n' THEN v.adj_n[r.a]
         ELSE          v.adj_pl[r.a]
       END
         || ' ' || v.nouns[r.n]
         || ' ' || v.brands[r.b]
         || ' ' || chr(65 + r.i % 26) || '-' || (1000 + (r.i * 7919) % 9000),
       'Матеріал: ' || v.materials[r.m]
         || '. Колір: ' || v.colours[r.c]
         || '. Підходить для ' || v.purposes[r.p]
         || '. Гарантія ' || (ARRAY[6, 12, 24])[floor(r.r2 * 3)::int + 1]
         || ' місяців. Доставка по Україні.',
       round((CASE
         WHEN r.n <= 6  THEN  800 + power(r.r3, 2) *  3200
         WHEN r.n <= 14 THEN  300 + power(r.r3, 2) *  2700
         WHEN r.n <= 22 THEN 2000 + power(r.r3, 2) * 58000
         WHEN r.n <= 30 THEN  200 + power(r.r3, 2) * 14800
         WHEN r.n <= 36 THEN  150 + power(r.r3, 2) * 29850
         ELSE                 100 + power(r.r3, 2) *   800
       END)::numeric, 2),
       CASE WHEN r.r2 < 0.12 THEN 0 ELSE floor(r.r2 * 80)::int + 1 END,   -- 12 % без залишку
       CASE WHEN r.r4 < 0.40 THEN NULL ELSE round((3 + r.r1 * 2)::numeric, 2) END,
       CASE WHEN r.r4 < 0.40 THEN 0    ELSE floor((r.r4 - 0.40) / 0.60 * 500)::int + 1 END,
       ARRAY['products/' || r.i || '/main.webp'],
       now() - random() * interval '730 days'
FROM r CROSS JOIN v;

-- ---------------------------------------------------------------------------
-- orders + order_items. Спершу позиції у тимчасову таблицю (1–4 на замовлення,
-- дублікати товару в одному замовленні злиті), потім замовлення із сумою по
-- своїх позиціях, потім самі позиції зі знімком ціни.
-- ---------------------------------------------------------------------------
-- Кількість позицій — окремою колонкою на замовлення, а LATERAL розгортає її
-- в рядки. Фільтр на кшталт WHERE random() < 0.35 тут не годиться: він не
-- залежить від замовлення, і планер обчислює його один раз на весь
-- generate_series, а не на кожен рядок.
CREATE TEMP TABLE seed_lines AS
SELECT o.order_no,
       floor(random() * 120000)::int + 1 AS product_id,
       floor(random() * 3)::int + 1      AS qty
FROM (SELECT o AS order_no,
             1 + floor(power(random(), 2) * 4)::int AS n_items   -- половина замовлень з однією позицією
      FROM generate_series(1, 200000) AS o) AS o
CROSS JOIN LATERAL generate_series(1, o.n_items) AS k;

CREATE TEMP TABLE seed_items AS
SELECT order_no, product_id, sum(qty)::int AS qty
FROM seed_lines
GROUP BY order_no, product_id;

INSERT INTO orders (id, buyer_id, device_id, region, status, currency,
                    subtotal, discount, total, points_spent, created_at)
OVERRIDING SYSTEM VALUE
SELECT s.order_no,
       -- добуток двох random() дає кількох дуже активних покупців і довгий хвіст
       floor(random() * random() * 49999)::int + 1,
       CASE WHEN random() < 0.85 THEN md5('device-' || s.order_no) END,
       CASE WHEN s.r1 < 0.80 THEN 'UA' WHEN s.r1 < 0.92 THEN 'EU' WHEN s.r1 < 0.98 THEN 'US' ELSE 'CN' END,
       CASE WHEN s.r2 < 0.90 THEN 'paid' WHEN s.r2 < 0.96 THEN 'pending' ELSE 'cancelled' END,
       'UAH',
       s.subtotal, 0, s.subtotal, 0,
       now() - random() * interval '730 days'
FROM (
  SELECT si.order_no,
         sum(si.qty * p.price) AS subtotal,
         random() AS r1,
         random() AS r2
  FROM seed_items AS si
  JOIN products   AS p ON p.id = si.product_id
  GROUP BY si.order_no
) AS s;

INSERT INTO order_items (order_id, product_id, qty, unit_price, discount, promotion_id)
SELECT si.order_no, si.product_id, si.qty, p.price, 0, NULL
FROM seed_items AS si
JOIN products   AS p ON p.id = si.product_id;

DROP TABLE seed_lines, seed_items;

-- Sequences не рухались, бо id задавались явно. Підтягую їх до max(id).
SELECT setval(pg_get_serial_sequence('users',    'id'), (SELECT max(id) FROM users));
SELECT setval(pg_get_serial_sequence('products', 'id'), (SELECT max(id) FROM products));
SELECT setval(pg_get_serial_sequence('orders',   'id'), (SELECT max(id) FROM orders));

-- Не ANALYZE, а VACUUM (ANALYZE): статистику планеру дає ANALYZE, а visibility
-- map виставляє VACUUM. Без неї Index Only Scan усе одно ходить у таблицю за
-- кожним рядком (Heap Fetches у плані), і buffers «після» в сотні разів гірші.
VACUUM (ANALYZE);

-- Контроль обсягу й перекосу — те, на що спирається кожен план далі.
SELECT 'users'       AS "table", count(*) FROM users
UNION ALL SELECT 'products',    count(*) FROM products
UNION ALL SELECT 'orders',      count(*) FROM orders
UNION ALL SELECT 'order_items', count(*) FROM order_items;

SELECT status, count(*), round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM orders GROUP BY status ORDER BY count DESC;
