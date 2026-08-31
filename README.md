# Marketplace API

Курсовий проєкт, Node.js PRO. **ДЗ #9 — API design.**

Стек: **NestJS 11 + TypeScript**, Express 5 під капотом, `express-openapi-validator`
на кордоні. Спека — джерело правди сервісу: по її ресурсах далі проєктується
схема БД (#12), entities (#13) і транзакційне оформлення замовлення (#14).

## Обраний варіант: **Б — runtime-валідація на кордоні**

`express-openapi-validator` читає `openapi/openapi.yaml` і фізично відхиляє все,
що спеці суперечить — у **обидва** боки:

* **на вході** — відсутній `Idempotency-Key`, порожній `items`, `qty: "two"`,
  `qty: -5`, `limit > 100`, незадеклароване поле на будь-якій глибині. Жодного
  `if` у контролері немає: вимогу тримає контракт;
* **на виході** — `validateResponses: true`. Якщо обробник віддасть не те, що
  обіцяє спека, клієнт отримає `500`, а не тихо зіпсовані дані.

Помилки перекладає в `application/problem+json` (RFC 9457) один
`ProblemFilter` — глобальний `ExceptionFilter` Nest. Він же транслює
`path`/`message` валідатора в `pointer`/`detail`: підполя названі як у прикладі
RFC 9457 §3.

## Запуск

```bash
npm install
npm start            # tsc → node dist/main.js, http://localhost:3000/v1
npm run start:dev    # без білду, через ts-node
npm run typecheck    # tsc --noEmit
```

## Структура

| Файл | Що в ньому |
| --- | --- |
| `openapi/openapi.yaml` | спека: 2 ресурси, 5 операцій, cursor-пагінація, `Idempotency-Key`, `problem+json` |
| `src/main.ts` | bootstrap: `express.json()` → валідатор → глобальний `ProblemFilter` |
| `src/app.module.ts` | модуль: контролери + провайдери |
| `src/common/problem.filter.ts` | будь-яка помилка → RFC 9457 |
| `src/common/http-problem.ts` | власна помилка з `code`, звіреним із `enum` у спеці |
| `src/common/cursor.ts` | keyset-курсор: `encode` / `decode` / `paginate` |
| `src/catalog/` | `CatalogService` (in-memory каталог) + `ProductsController` |
| `src/orders/` | `OrdersService`, `IdempotencyService`, `OrdersController` |
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

Валідатор рубає й те, чого в коді ніхто не передбачав:

```
{"items":[{"product_id":1,"qty":1,"hack":true}]} → 400 "request/body/items/0 must NOT have additional properties"
{"items":[{"product_id":1,"qty":"two"}]}         → 400 "request/body/items/0/qty must be integer"
{"items":[{"product_id":1,"qty":-5}]}            → 400 "request/body/items/0/qty must be >= 1"
GET /v1/products?limit=999                        → 400 "request/query/limit must be <= 100"
GET /v1/wat                                       → 404 problem+json, не HTML express
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
# два одночасні запити з тим самим ключем і тим самим тілом: A → 201, B → 409
# з РІЗНИМ тілом:                                            A → 201, B → 422
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

### Спека

* **Версія в `servers.url`, а не в шляхах.** `/v1/products` у `paths` зробив би
  всі ресурси одним (`v1`) для будь-якого інструменту, що дивиться на перший
  сегмент. Версія — властивість розгортання; `v1`/`v2` у шляхах зʼявляться тоді,
  коли обидві реально працюватимуть. У коді їй відповідає
  `app.setGlobalPrefix('v1')`.
* **`security: []` на корені** — авторизації свідомо ще немає (приїде на #24).
  Порожній масив документує це явно й закриває redocly-правило `security-defined`.
* **`default`-відповідь у кожній операції.** Без неї `validateResponses: true`
  відкидав би власну `500`-у сервера як незадекларовану й ховав першопричину.
* **`additionalProperties: false` на КОЖНОМУ обʼєкті — і в запитах, і у
  відповідях.** У `CreateOrder` воно стосується лише верхнього рівня тіла, тому
  `{"product_id":1,"qty":1,"hack":true}` проходив у `201`, поки те саме не
  зʼявилось в `OrderItem`. На схемах відповідей це дає те, що на L#4 робив
  серіалізатор Fastify: віддати незадеклароване поле фізично не вийде.
* **`OrderLine` виписаний повністю, а не через `allOf` з `OrderItem`.** Під
  `allOf` кожна підсхема валідується окремо, тож `additionalProperties: false`
  в `OrderItem` відкидав би `unit_price_cents` із сусідньої гілки.
* **`Problem.type` — закритий `enum` з усіх десяти URI.** Клієнт матчить помилку
  по `type`, тож перелік має бути в контракті. Побічний ефект корисний: новий тип
  помилки неможливо віддати, не дописавши його у спеку — інакше
  `validateResponses` відкине власну відповідь сервера. У коді цьому відповідає
  тип `ProblemCode` у `src/common/http-problem.ts`.
* **Сам `Problem` лишається відкритим** (без `additionalProperties: false`) —
  RFC 9457 §3.2 прямо дозволяє розширення й зобовʼязує клієнтів ігнорувати
  нерозпізнані. Закрити його означало б заборонити те, що стандарт вимагає
  підтримувати.
* **Гроші — цілі копійки.** `total_cents: integer`. Ніяких `"2600.00"`.
* **Ціна копіюється в замовлення** (`unit_price_cents`), а не читається з
  каталогу: інакше зміна цінника перепише історію оплачених замовлень.

### Nest + валідатор

* **`bodyParser: false` у `NestFactory.create`, далі `app.use(express.json())`
  вручну.** Власний body-parser Nest реєструється не там, де треба: валідатор
  бачив `request must have required property 'body'` на цілком валідному JSON,
  бо тіло ще не було розпарсене. Тепер порядок заданий явно й видимий.
* **Одна точка на всі помилки — `ExceptionFilter` Nest, без окремого
  Express-обробника.** `express-openapi-validator` — це Express-middleware перед
  роутером Nest, тож логічно було очікувати, що його помилки полетять у
  Express-ланцюжок мимо фільтрів. Перевірено — вони доходять до
  `useGlobalFilters`: і `400` від валідації запиту, і `500` від
  `validateResponses`.
* **Один інстанс express.** `@nestjs/platform-express@11` тягне `express@5.2.1`
  своєю залежністю; поки в `package.json` стояв `express@4`, у дереві було
  **дві** копії, і валідатор створював Router від express 4 всередині app
  express 5. У `dependencies` тепер `express@5.2.1` — та сама версія, тож npm
  зводить усе до однієї (`npm ls express` показує три `deduped`).
* **`ts-node`, ніколи `tsx`.** esbuild викидає `emitDecoratorMetadata`, і DI
  Nest перестає бачити типи конструктора.
* **Сховище ключів у памʼяті** не переживає рестарт — після нього той самий ключ
  створить замовлення вдруге. Спільне сховище (Redis) приїде на #23;
  `IdempotencyService` уже провайдер, тож заміна не торкнеться контролера.
