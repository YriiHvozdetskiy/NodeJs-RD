# Marketplace API

Курсовий проєкт, Node.js PRO. **ДЗ #9 — API design.**

Спека — джерело правди цього сервісу. По її ресурсах далі проєктується схема БД
(#12), entities (#13) і транзакційне оформлення замовлення (#14).

## Обраний варіант: **Б — runtime-валідація на кордоні**

`express-openapi-validator` читає `openapi/openapi.yaml` і фізично відхиляє все,
що спеці суперечить — у **обидва** боки:

* **на вході** — відсутній `Idempotency-Key`, порожній `items`, `limit > 100`,
  незадеклароване поле в тілі. Жодного `if` у коді немає: вимогу тримає контракт;
* **на виході** — `validateResponses: true`. Якщо обробник віддасть не те, що
  обіцяє спека, клієнт отримає `500`, а не тихо зіпсовані дані.

Помилки перекладає в `application/problem+json` (RFC 9457) один error-handler у
`src/app.js`. Він же транслює `path`/`message` валідатора в `pointer`/`detail` —
підполя названі як у прикладі RFC 9457 §3.

## Запуск

```bash
npm install
npm start                 # http://localhost:3000/v1
```

## Структура

| Файл | Що в ньому |
|---|---|
| `openapi/openapi.yaml` | спека: 2 ресурси, 5 операцій, cursor-пагінація, `Idempotency-Key`, `problem+json` |
| `src/app.js` | express + валідатор + 5 обробників + error-handler → problem+json |
| `src/problem.js` | нормалізація будь-якої помилки в RFC 9457 |
| `src/cursor.js` | keyset-курсор: `encode`/`decode`/`paginate` |
| `src/idempotency.js` | сховище ключів у памʼяті + рішення про повтор |
| `src/data.js` | in-memory каталог і замовлення (на #13 стане TypeORM) |
| `scripts/check-scope.js` | перевірка обсягу спеки з acceptance criteria, файлом |

## Acceptance criteria — команди

### 1. Спека валідна

```bash
npx @redocly/cli lint openapi/openapi.yaml    # exit 0, 2 warning (license, localhost)
```

### 2. Обсяг спеки

```bash
npx @redocly/cli bundle openapi/openapi.yaml -o spec.json
node scripts/check-scope.js
# операцій: 5 · ресурсів: 2
# Idempotency-Key: required = true · опис, символів = 1064
```

`Idempotency-Key` оголошений **інлайном** у `POST /orders`, а не через `$ref`:
`redocly bundle` не розкриває внутрішні `$ref`, і перевірка вище побачила б
`{"$ref": "..."}` замість параметра.

### 3–5. grep-критерії

```bash
grep -c 'Idempotency-Key' openapi/openapi.yaml          # 4
grep -c 'next_cursor' openapi/openapi.yaml              # 5
grep -c 'application/problem+json' openapi/openapi.yaml # 6
```

### 6. Contract-частина працює (варіант Б)

`npm start` в одному терміналі, далі:

```bash
B=http://localhost:3000/v1

# без Idempotency-Key → 400, і content-type вимагає СПЕКА, а не if у коді
curl -i -X POST $B/orders -H 'content-type: application/json' \
  -d '{"items":[{"product_id":1,"qty":1}]}'
# HTTP/1.1 400 · Content-Type: application/problem+json
# detail: "request/headers must have required property 'idempotency-key'"

# невалідне тіло → 400 з деталлю від валідатора
curl -X POST $B/orders -H 'content-type: application/json' \
  -H 'Idempotency-Key: 7f3c1d2e-8a44-4b90-9c11-000000000001' -d '{"items":[]}'
# detail: "request/body/items must NOT have fewer than 1 items"

# валідний запит → 201 + Location
curl -i -X POST $B/orders -H 'content-type: application/json' \
  -H 'Idempotency-Key: 7f3c1d2e-8a44-4b90-9c11-000000000002' \
  -d '{"items":[{"product_id":1,"qty":2}]}'
# HTTP/1.1 201 · Location: /v1/orders/6
```

## Додатковий виклик — повна семантика ключа

```bash
K='7f3c1d2e-8a44-4b90-9c11-000000000002'
BODY='{"items":[{"product_id":1,"qty":2}]}'

# той самий ключ + те саме тіло → 201 + Idempotency-Replay: true, обробник НЕ біг
curl -i -X POST $B/orders -H 'content-type: application/json' -H "Idempotency-Key: $K" -d "$BODY"

# той самий ключ + ІНШЕ тіло → 422 (тіло валідне; помилка в реюзі ключа)
curl -X POST $B/orders -H 'content-type: application/json' -H "Idempotency-Key: $K" \
  -d '{"items":[{"product_id":1,"qty":3}]}'
```

**409 «ключ у польоті».** Синхронний обробник ніколи не перериває себе, тож у
звичайному режимі ця гілка недосяжна фізично. Щоб її побачити, є `SLOW_MS` —
затримка, яка імітує майбутню транзакцію в Postgres з #14:

```bash
SLOW_MS=400 npm start
# і два одночасні запити з тим самим ключем: A → 201, B → 409
```

## Cursor-пагінація

```bash
curl -s "$B/products?limit=3"
# {"items":[…id 7,6,5…],"next_cursor":"eyJjIjoiMjAyNi0wOC0wNFQxMDowMDowMC4wMDBaIiwiaWQiOjV9"}

curl -s "$B/products?limit=3&cursor=<той-самий-токен>"
# ids 4,3,2 — товари 4 і 5 мають ОДНАКОВИЙ created_at, і без id у курсорі
# один із них зник би між сторінками назавжди
```

Курсор непрозорий: `base64url` — деталь реалізації сервера, а не публічний
формат. Зламаний токен → `400` з `type: .../invalid-cursor`.

## Перевірити, що валідатор ловить дрейф коду

`DRIFT=1` перейменовує в обробнику `total_cents` → `totalCents` і губить
`currency`, **не чіпаючи спеку** — рантайм-аналог `contract/check.mjs` з лекції:

```bash
DRIFT=1 npm start
curl -s $B/orders/1
# 500 · detail: "/response must have required property 'total_cents'"
curl -s "$B/orders?limit=2"
# 500 · detail: "/response/items/0 must have required property 'total_cents'"
```

Без `DRIFT` ті самі запити віддають `200`.

## Свідомі рішення

* **Версія в `servers.url`, а не в шляхах.** `/v1/products` у `paths` зробив би
  всі ресурси одним (`v1`) для будь-якого інструменту, що дивиться на перший
  сегмент. Версія — властивість розгортання; `v1`/`v2` у шляхах зʼявляться тоді,
  коли обидві реально працюватимуть.
* **`security: []` на корені** — авторизації свідомо ще немає (приїде на #24).
  Порожній масив документує це явно й закриває redocly-правило `security-defined`.
* **`default`-відповідь у кожній операції.** Без неї `validateResponses: true`
  відкидав би власну `500`-у сервера як незадекларовану й ховав першопричину.
* **`additionalProperties: false` на КОЖНОМУ обʼєкті — і в запитах, і у
  відповідях.** У `CreateOrder` воно стосується лише верхнього рівня тіла, тому
  `{"product_id":1,"qty":1,"hack":true}` проходив у `201`, поки те саме не
  зʼявилось в `OrderItem`. На схемах відповідей це дає те, що на L#4 робив
  серіалізатор Fastify: віддати незадекларіване поле фізично не вийде —
  `validateResponses` віддасть `500 "/response/items/0 must NOT have additional
  properties"`.
* **`OrderLine` виписаний повністю, а не через `allOf` з `OrderItem`.** Під
  `allOf` кожна підсхема валідується окремо, тож `additionalProperties: false`
  в `OrderItem` відкидав би `unit_price_cents` із сусідньої гілки.
* **`Problem.type` — закритий `enum` з усіх десяти URI.** Клієнт матчить помилку
  по `type`, тож перелік має бути в контракті, а не тільки в голові. Побічний
  ефект корисний: новий тип помилки неможливо віддати, не дописавши його у спеку
  — інакше `validateResponses` відкине власну відповідь сервера.
* **Сам `Problem` при цьому лишається відкритим** (без
  `additionalProperties: false`) — RFC 9457 §3.2 прямо дозволяє розширення й
  зобовʼязує клієнтів ігнорувати нерозпізнані. Закрити його означало б
  заборонити те, що стандарт вимагає підтримувати.
* **Гроші — цілі копійки.** `total_cents: integer`. Ніяких `"2600.00"`.
* **Ціна копіюється в замовлення** (`unit_price_cents`), а не читається з
  каталогу: інакше зміна цінника перепише історію оплачених замовлень.
* **`in-flight` + інше тіло → `422`, а не `409`.** Порядок перевірок у
  `decide()` не довільний: відпечаток тіла порівнюється **раніше** за стан. Це
  можливо тільки тому, що `markInFlight()` пише fingerprint ДО запуску
  обробника. «Тіло інше» — остаточний факт про клієнта, «ще в польоті» —
  тимчасовий стан сервера; `409` наказав би повторити запит, який ніколи не
  пройде.
* **Сховище ключів у памʼяті** не переживає рестарт — після нього той самий ключ
  створить замовлення вдруге. Спільне сховище (Redis) приїде на #23.
