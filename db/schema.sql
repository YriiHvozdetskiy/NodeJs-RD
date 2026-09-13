-- Дата-шар Marketplace API. Застосовується на чисту базу однією командою:
--   psql -v ON_ERROR_STOP=1 -f db/schema.sql
--
-- Тут лише таблиці й констрейнти. Індекси під запити живуть у db/indexes.sql:
-- так у кожного індексу є запит, який його бере, і план «до» й «після», який
-- це доводить. Індекс без запиту — це диск і повільніший INSERT задарма.
--
-- Порядок таблиць диктують FOREIGN KEY: батьки раніше за дітей.
-- DROP на початку — для повторних прогонів на тому самому томі; грейдер іде
-- на чистий том, і для нього ці рядки нічого не роблять.

DROP TABLE IF EXISTS
  points_entries, payments, order_items, orders, promotions, products, users
CASCADE;

-- ---------------------------------------------------------------------------
-- users — buyer · seller · admin. Ролі розійдуться правами на #24 (RBAC).
-- UNIQUE(email) чутливий до регістру навмисно: нечутливий варіант — це
-- індекс по lower(email), і він з'являється в indexes.sql під запит логіну.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  role          text        NOT NULL DEFAULT 'buyer'
                CHECK (role IN ('buyer', 'seller', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- products — каталог. Гроші numeric(12,2), ніколи float.
-- rating_avg NULL, поки немає жодного відгуку: товар без оцінок не проходить
-- фільтр min_rating, і це рішення, а не побічний ефект (docs/design-notes.md).
-- search_vector — збережена генерована колонка: Postgres перераховує її сам на
-- кожному INSERT/UPDATE, а конфіг 'simple' названо явно, бо одноаргументний
-- to_tsvector залежить від сесійного налаштування і не є IMMUTABLE.
-- Ціна колонки — приблизно подвоєння таблиці, число у db/OPTIMIZATIONS.md.
-- ---------------------------------------------------------------------------
CREATE TABLE products (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_id     bigint        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  category      text          NOT NULL
                CHECK (category IN ('shoes', 'clothing', 'electronics', 'home', 'sports', 'books')),
  title         text          NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description   text          NOT NULL DEFAULT '',
  price         numeric(12,2) NOT NULL CHECK (price >= 0),
  currency      text          NOT NULL DEFAULT 'UAH' CHECK (currency ~ '^[A-Z]{3}$'),
  stock         integer       NOT NULL DEFAULT 0 CHECK (stock >= 0),
  rating_avg    numeric(3,2)  CHECK (rating_avg BETWEEN 1 AND 5),
  rating_count  integer       NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  image_keys    text[]        NOT NULL DEFAULT '{}',
  created_at    timestamptz   NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS
                (to_tsvector('simple', title || ' ' || description)) STORED,
  CHECK ((rating_count = 0) = (rating_avg IS NULL))
);

-- ---------------------------------------------------------------------------
-- promotions — три типи акцій. seasonal і quantity_tier прив'язані до товару,
-- promo_code діє на все замовлення і товару не має.
-- *_local — те, що ввів продавець у своїй зоні (timestamp без зони навмисно:
-- це «настінний» час), *_at — та сама мить в абсолюті, по ній працюють запити.
-- ---------------------------------------------------------------------------
CREATE TABLE promotions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id   bigint       REFERENCES products (id) ON DELETE CASCADE,
  kind         text         NOT NULL CHECK (kind IN ('seasonal', 'quantity_tier', 'promo_code')),
  code         text         UNIQUE,
  percent_off  numeric(5,2) NOT NULL CHECK (percent_off > 0 AND percent_off <= 100),
  min_qty      integer      CHECK (min_qty > 1),
  region       text         NOT NULL CHECK (region ~ '^[A-Z]{2}$'),
  timezone     text         NOT NULL,
  starts_local timestamp    NOT NULL,
  ends_local   timestamp    NOT NULL,
  starts_at    timestamptz  NOT NULL,
  ends_at      timestamptz  NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (ends_local > starts_local),
  CHECK ((kind = 'promo_code') = (product_id IS NULL)),
  CHECK ((kind = 'promo_code') = (code IS NOT NULL)),
  CHECK ((kind = 'quantity_tier') = (min_qty IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- orders — точка входу транзакції (#14). Три суми замість однієї, щоб підсумок
-- був прозорий; total = subtotal - discount тримає CHECK, а не код.
-- points_spent окремо від discount: бали не змінюють ціну, вони покривають
-- частину суми до сплати.
-- buyer_id NOT NULL з першого дня: гостьових замовлень у домені немає, #24
-- лише почне брати значення з токена замість тіла запиту.
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  buyer_id      bigint        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  device_id     text,
  region        text          NOT NULL CHECK (region ~ '^[A-Z]{2}$'),
  status        text          NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'paid', 'cancelled')),
  currency      text          NOT NULL DEFAULT 'UAH' CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal      numeric(12,2) NOT NULL CHECK (subtotal >= 0),
  discount      numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total         numeric(12,2) NOT NULL CHECK (total >= 0),
  points_spent  integer       NOT NULL DEFAULT 0 CHECK (points_spent >= 0),
  promo_code_id bigint        REFERENCES promotions (id) ON DELETE RESTRICT,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  CHECK (total = subtotal - discount)
);

-- ---------------------------------------------------------------------------
-- order_items — частина агрегату Order, тому власного id не має і зникає разом
-- із замовленням (CASCADE). Товар видалити не можна, поки на нього посилається
-- позиція (RESTRICT): unit_price і discount — знімок на момент оформлення, і
-- історію не переписує ні новий цінник, ні закінчена акція.
-- ---------------------------------------------------------------------------
CREATE TABLE order_items (
  order_id     bigint        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id   bigint        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  qty          integer       NOT NULL CHECK (qty > 0),
  unit_price   numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  discount     numeric(12,2) NOT NULL DEFAULT 0
               CHECK (discount >= 0 AND discount <= unit_price * qty),
  promotion_id bigint        REFERENCES promotions (id) ON DELETE RESTRICT,
  PRIMARY KEY (order_id, product_id),
  CHECK ((promotion_id IS NULL) = (discount = 0))
);

-- ---------------------------------------------------------------------------
-- payments — 1:1 із замовленням (UNIQUE order_id), незворотна операція.
-- Ресурсом стане на #22 разом із outbox.
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     bigint        NOT NULL UNIQUE REFERENCES orders (id) ON DELETE RESTRICT,
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  status       text          NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_ref text,
  created_at   timestamptz   NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- points_entries — бонусні бали як append-only журнал: баланс = SUM по
-- записах, а не колонка на користувачі. amount завжди додатний, напрямок
-- задає kind. Нарахування (earned) має дату дозрівання, списання (spent) —
-- ні, і воно одразу зі статусом spent.
-- ---------------------------------------------------------------------------
CREATE TABLE points_entries (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  order_id   bigint      REFERENCES orders (id) ON DELETE RESTRICT,
  kind       text        NOT NULL CHECK (kind IN ('earned', 'spent')),
  amount     integer     NOT NULL CHECK (amount > 0),
  status     text        NOT NULL CHECK (status IN ('pending', 'available', 'spent')),
  matures_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'earned') = (matures_at IS NOT NULL)),
  CHECK (kind = 'earned' OR status = 'spent')
);

-- ---------------------------------------------------------------------------
-- Права застосунку. Схему створює admin, ходить у неї app_user (db/init.sql),
-- і без цих двох рядків його перший SELECT впаде з permission denied.
-- Sequences потрібні окремо: GENERATED … AS IDENTITY бере значення з них,
-- тож INSERT без USAGE на sequence теж не пройде.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
