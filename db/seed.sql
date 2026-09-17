-- Реалістичний обсяг під EXPLAIN. Наливаю всі сім таблиць дата-шару:
--   users 50 000 · products 120 000 · promotions 12 040 · orders 200 000 ·
--   order_items ≈ 386 000 · payments ≈ 180 000 · points_entries ≈ 179 000.
--
-- Акції, платежі й бали тут не для планів q1–q4, а щоб під обсягом були
-- перевірені ВСІ десять FOREIGN KEY, включно з orders.promo_code_id і
-- order_items.promotion_id: порожня таблиця не доводить нічого про зв'язок.
--
-- Порядок побудови важливий. Знижки рахуються ДО вставки, у тимчасових
-- таблицях, і кожен рядок вставляється один раз. Варіант «вставити
-- замовлення, потім UPDATE зі знижкою» дав би мертвий кортеж на кожен
-- оновлений рядок: VACUUM позначив би місце вільним, але файл не стиснув, і
-- heap orders у звіті перестав би відповідати чистому наливанню.
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
-- promotions: 12 000 акцій на товари (60 % seasonal, 40 % quantity_tier) плюс
-- 40 промокодів на замовлення. Вікна по 90–210 днів, розкидані по тих самих
-- 730 днях, що й замовлення: інакше жодна акція не збіглася б у часі з жодним
-- замовленням і FK лишився б неперевіреним.
-- Регіон перекошений як у замовлень (80/12/6/2) — акція діє в одному регіоні.
-- *_local отримую з *_at через AT TIME ZONE: це рівно та семантика з README —
-- продавець ввів «настінний» час своєї зони, у базі лежить абсолютна мить.
-- percent_off ≤ 50 навмисно: при 100 % замовлення могло б вийти в нуль, а
-- payments.amount має CHECK > 0.
-- ---------------------------------------------------------------------------
INSERT INTO promotions (id, product_id, kind, code, percent_off, min_qty, region,
                        timezone, starts_local, ends_local, starts_at, ends_at, created_at)
OVERRIDING SYSTEM VALUE
SELECT g.id,
       g.product_id,
       g.kind,
       CASE WHEN g.kind = 'promo_code'    THEN 'SALE' || g.id END,
       g.percent_off,
       CASE WHEN g.kind = 'quantity_tier' THEN 2 + (g.id % 2) END,
       g.region,
       tz.name,
       g.starts_at AT TIME ZONE tz.name,
       g.ends_at   AT TIME ZONE tz.name,
       g.starts_at,
       g.ends_at,
       g.starts_at - interval '7 days'
FROM (
  SELECT b.id,
         b.kind,
         CASE WHEN b.kind <> 'promo_code' THEN floor(random() * 120000)::int + 1 END AS product_id,
         round((5 + random() * 45)::numeric, 2) AS percent_off,
         CASE WHEN b.r1 < 0.80 THEN 'UA' WHEN b.r1 < 0.92 THEN 'EU'
              WHEN b.r1 < 0.98 THEN 'US' ELSE 'CN' END AS region,
         b.starts_at,
         b.starts_at + (90 + random() * 120) * interval '1 day' AS ends_at
  FROM (
    SELECT i AS id,
           CASE WHEN i > 12000        THEN 'promo_code'
                WHEN random() < 0.60  THEN 'seasonal'
                ELSE                       'quantity_tier' END AS kind,
           random() AS r1,
           now() - random() * interval '730 days' AS starts_at
    FROM generate_series(1, 12040) AS i
  ) AS b
) AS g
CROSS JOIN LATERAL (
  SELECT CASE g.region WHEN 'UA' THEN 'Europe/Kyiv'
                       WHEN 'EU' THEN 'Europe/Berlin'
                       WHEN 'US' THEN 'America/New_York'
                       ELSE           'Asia/Shanghai' END AS name
) AS tz;

-- ---------------------------------------------------------------------------
-- orders + order_items. Чотири тимчасові кроки, щоб кожен рядок вставити один
-- раз: атрибути замовлення → позиції → ціна й акція на позицію → промокод на
-- замовлення. Дата потрібна раніше за акцію, бо акція шукається саме на цю мить.
-- ---------------------------------------------------------------------------
-- Кількість позицій — окремою колонкою на замовлення, а LATERAL розгортає її
-- в рядки. Фільтр на кшталт WHERE random() < 0.35 тут не годиться: він не
-- залежить від замовлення, і планер обчислює його один раз на весь
-- generate_series, а не на кожен рядок.
CREATE TEMP TABLE seed_orders AS
SELECT g.order_no,
       -- добуток двох random() дає кількох дуже активних покупців і довгий хвіст
       floor(random() * random() * 49999)::int + 1 AS buyer_id,
       CASE WHEN random() < 0.85 THEN md5('device-' || g.order_no) END AS device_id,
       CASE WHEN g.r1 < 0.80 THEN 'UA' WHEN g.r1 < 0.92 THEN 'EU'
            WHEN g.r1 < 0.98 THEN 'US' ELSE 'CN' END AS region,
       CASE WHEN g.r2 < 0.90 THEN 'paid' WHEN g.r2 < 0.96 THEN 'pending'
            ELSE 'cancelled' END AS status,
       now() - random() * interval '730 days' AS created_at,
       1 + floor(power(random(), 2) * 4)::int AS n_items   -- половина замовлень з однією позицією
FROM (SELECT o AS order_no, random() AS r1, random() AS r2
      FROM generate_series(1, 200000) AS o) AS g;

CREATE TEMP TABLE seed_lines AS
SELECT so.order_no,
       floor(random() * 120000)::int + 1 AS product_id,
       floor(random() * 3)::int + 1      AS qty
FROM seed_orders AS so
CROSS JOIN LATERAL generate_series(1, so.n_items) AS k;

CREATE TEMP TABLE seed_items AS
SELECT order_no, product_id, sum(qty)::int AS qty
FROM seed_lines
GROUP BY order_no, product_id;

-- Ціна — знімок на момент оформлення, акція — та, що діяла саме тоді, у
-- регіоні замовлення й на цей товар; quantity_tier ще й вимагає qty ≥ min_qty.
-- Округлення може дати 0.00 на дешевій книжці — тоді позиція лишається без
-- акції: schema.sql тримає CHECK (promotion_id IS NULL) = (discount = 0).
-- LEFT JOIN + DISTINCT ON, а не LATERAL … LIMIT 1: у LATERAL-формі планер
-- вимушено бере nested loop і перечитує 12 тисяч акцій на кожну з 385 тисяч
-- позицій — сід тривав 4.5 хвилини замість 30 секунд. Звичайний join дає
-- hash join по product_id, DISTINCT ON лишає найвигіднішу акцію на позицію.
CREATE TEMP TABLE seed_priced AS
SELECT x.order_no, x.product_id, x.qty, x.unit_price,
       CASE WHEN x.discount > 0 THEN x.promotion_id END AS promotion_id,
       CASE WHEN x.discount > 0 THEN x.discount ELSE 0 END AS discount
FROM (
  SELECT DISTINCT ON (si.order_no, si.product_id)
         si.order_no, si.product_id, si.qty,
         p.price AS unit_price,
         pm.id   AS promotion_id,
         COALESCE(round(p.price * si.qty * pm.percent_off / 100, 2), 0) AS discount
  FROM seed_items  AS si
  JOIN products    AS p  ON p.id = si.product_id
  JOIN seed_orders AS so ON so.order_no = si.order_no
  LEFT JOIN promotions AS pm
         ON pm.product_id  = si.product_id
        AND pm.region      = so.region
        AND so.created_at >= pm.starts_at
        AND so.created_at <  pm.ends_at
        AND (pm.min_qty IS NULL OR si.qty >= pm.min_qty)
  ORDER BY si.order_no, si.product_id, pm.percent_off DESC NULLS LAST, pm.id
) AS x;

-- Промокод — кожному тринадцятому замовленню, і рівно один раз на пару
-- (покупець, код). Правило «один код на користувача» описане в
-- docs/design-notes.md як частковий унікальний індекс; він з'явиться на #14, і
-- DISTINCT ON тут гарантує, що створити його можна буде без чистки даних.
CREATE TEMP TABLE seed_promo_codes AS
SELECT id, region, percent_off, starts_at, ends_at
FROM promotions WHERE kind = 'promo_code';

-- Два DISTINCT ON поспіль, і обидва обов'язкові: внутрішній лишає рівно один
-- код на замовлення (інакше замовлення задвоїлось би в INSERT нижче),
-- зовнішній — рівно одне замовлення на пару (покупець, код).
CREATE TEMP TABLE seed_order_promo AS
SELECT DISTINCT ON (c.buyer_id, c.promo_code_id)
       c.order_no, c.promo_code_id, c.percent_off
FROM (
  SELECT DISTINCT ON (so.order_no)
         so.order_no, so.buyer_id, so.created_at,
         pc.id AS promo_code_id, pc.percent_off
  FROM seed_orders     AS so
  JOIN seed_promo_codes AS pc
        ON pc.region     = so.region
       AND so.created_at >= pc.starts_at
       AND so.created_at <  pc.ends_at
  WHERE so.order_no % 13 = 0
  ORDER BY so.order_no, pc.id
) AS c
ORDER BY c.buyer_id, c.promo_code_id, c.created_at;

-- Знижка замовлення = знижки позицій + промокод на залишок після них.
-- total = subtotal - discount тримає CHECK у schema.sql, тому рахую один раз.
INSERT INTO orders (id, buyer_id, device_id, region, status, currency,
                    subtotal, discount, total, points_spent, promo_code_id, created_at)
OVERRIDING SYSTEM VALUE
SELECT o.order_no, o.buyer_id, o.device_id, o.region, o.status, 'UAH',
       o.subtotal, o.discount, o.subtotal - o.discount, 0, o.promo_code_id, o.created_at
FROM (
  SELECT so.order_no, so.buyer_id, so.device_id, so.region, so.status, so.created_at,
         agg.subtotal,
         agg.item_discount
           + COALESCE(round((agg.subtotal - agg.item_discount) * sp.percent_off / 100, 2), 0) AS discount,
         sp.promo_code_id
  FROM seed_orders AS so
  JOIN (SELECT order_no,
               sum(qty * unit_price) AS subtotal,
               sum(discount)         AS item_discount
        FROM seed_priced GROUP BY order_no) AS agg USING (order_no)
  LEFT JOIN seed_order_promo AS sp USING (order_no)
) AS o;

INSERT INTO order_items (order_id, product_id, qty, unit_price, discount, promotion_id)
SELECT order_no, product_id, qty, unit_price, discount, promotion_id
FROM seed_priced;

DROP TABLE seed_orders, seed_lines, seed_items, seed_priced,
           seed_promo_codes, seed_order_promo;

-- ---------------------------------------------------------------------------
-- payments: 1:1 з оплаченим замовленням. UNIQUE(order_id) у схемі — саме те,
-- що не дасть списати гроші двічі.
-- ---------------------------------------------------------------------------
INSERT INTO payments (order_id, amount, status, provider_ref, created_at)
SELECT id, total, 'succeeded', 'pi_' || md5('pay-' || id), created_at + interval '2 minutes'
FROM orders
WHERE status = 'paid' AND total > 0;

-- ---------------------------------------------------------------------------
-- points_entries: нарахування за оплачене замовлення, 1 бал за кожні повні
-- 100 грн. База — позиції БЕЗ акції: правило «бали не діють на акційну
-- позицію» з README виводиться з наявного promotion_id, окремого поля не
-- треба. Курс 1:100 — константа сіду, а не бізнес-рішення (див. README §4).
-- Дозріває через 14 днів: що встигло — available, решта — pending.
-- ---------------------------------------------------------------------------
INSERT INTO points_entries (user_id, order_id, kind, amount, status, matures_at, created_at)
SELECT o.buyer_id, o.id, 'earned', floor(base.amount / 100)::int,
       CASE WHEN o.created_at + interval '14 days' < now() THEN 'available' ELSE 'pending' END,
       o.created_at + interval '14 days',
       o.created_at
FROM orders AS o
JOIN (SELECT order_id, sum(qty * unit_price) AS amount
      FROM order_items WHERE promotion_id IS NULL
      GROUP BY order_id) AS base ON base.order_id = o.id
WHERE o.status = 'paid' AND base.amount >= 100;

-- Sequences не рухались там, де id задавались явно. Підтягую їх до max(id),
-- інакше перший INSERT застосунку впаде на дублікаті ключа.
SELECT setval(pg_get_serial_sequence('users',      'id'), (SELECT max(id) FROM users));
SELECT setval(pg_get_serial_sequence('products',   'id'), (SELECT max(id) FROM products));
SELECT setval(pg_get_serial_sequence('promotions', 'id'), (SELECT max(id) FROM promotions));
SELECT setval(pg_get_serial_sequence('orders',     'id'), (SELECT max(id) FROM orders));

-- Не ANALYZE, а VACUUM (ANALYZE): статистику планеру дає ANALYZE, а visibility
-- map виставляє VACUUM. Без неї Index Only Scan усе одно ходить у таблицю за
-- кожним рядком (Heap Fetches у плані), і buffers «після» в сотні разів гірші.
VACUUM (ANALYZE);

-- Контроль обсягу й перекосу — те, на що спирається кожен план далі.
SELECT 'users'          AS "table", count(*) FROM users
UNION ALL SELECT 'products',       count(*) FROM products
UNION ALL SELECT 'promotions',     count(*) FROM promotions
UNION ALL SELECT 'orders',         count(*) FROM orders
UNION ALL SELECT 'order_items',    count(*) FROM order_items
UNION ALL SELECT 'payments',       count(*) FROM payments
UNION ALL SELECT 'points_entries', count(*) FROM points_entries;

SELECT status, count(*), round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM orders GROUP BY status ORDER BY count DESC;

-- Жоден FK не лишився без жодного посилання: порожній стовпець тут означав би,
-- що зв'язок оголошений, але під обсягом не перевірений.
SELECT count(*) FILTER (WHERE promo_code_id IS NOT NULL) AS orders_with_promo_code
FROM orders;

SELECT count(*) FILTER (WHERE promotion_id IS NOT NULL) AS items_with_promotion
FROM order_items;
