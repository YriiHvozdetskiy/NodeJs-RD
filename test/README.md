# Тести

Раннер — вбудований `node:test`. Файли компілюються разом із `src/`
(`tsconfig.json` → `include: ["src", "test"]`), і `npm test` запускає вже
скомпільований JS: `tsc && node --test dist/test/`.

Іменувати файли треба `*.test.ts` — за цим патерном раннер Node їх і знаходить
у `dist/test/`.

⚠ **`import 'reflect-metadata'` має бути найпершим рядком кожного тестового
файлу** (або спільного setup-файлу). Без поліфіла `Reflect.getMetadata` просто
не існує, і падіння виглядатиме як «getMetadata is not a function», а не як
проблема з DI.

## Що має бути покрито (з acceptance criteria)

| # | Перевірка |
|---|---|
| 1 | A залежить від B, B від C — `resolve(A)` повертає екземпляр із живим C усередині |
| 2 | `resolve(X) === resolve(X)` → `true` для класу без явного скоупу |
| 3 | `resolve(X) === resolve(X)` → `false` для `@Injectable({ scope: 'transient' })` |
| 4 | залежність під `Symbol.for('CONFIG')` резолвиться саме за токеном, а не за типом |
| 5 | цикл `A -> B -> A` кидає помилку, повідомлення матчить `/A -> B -> A/`, і це **не** `RangeError` |

Мінімум — 5 тестів, бо саме стільки грейдер шукає у виводі (`# pass 5`).
