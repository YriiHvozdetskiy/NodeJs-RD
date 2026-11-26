// ESLint (#32) — друга половина сходинки «типи й стиль» конвеєра.
//
//   npm run lint        # = eslint src test
//
// tsc ловить те, що не складається за типами; лінтер — те, що складається, але
// на сервері ламається. Головні тут два правила з type information:
//   • no-floating-promises — проміс без await і без .catch: його reject стає
//     unhandledRejection і в Node 15+ вбиває ВЕСЬ процес, а не один запит;
//   • no-misused-promises — async-функція там, де чекають синхронну
//     (колбек EventEmitter, forEach): помилку з неї ніхто не дочекається.
// Обидва потребують типів, тому parserOptions.project — tsconfig.test.json:
// він охоплює і src, і test (tsconfig.json бачить лише src).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // Лінтуємо лише TypeScript застосунку й тестів. Решта — скрипти на чистому
  // Node, Pulumi-програма зі своїм package.json і згенерований код.
  globalIgnores(['dist/**', 'dist-test/**', 'node_modules/**', 'infra/**', 'scripts/**', 'demo/**', 'fixtures/**']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: { project: ['./tsconfig.test.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `const { currency, ...rest } = order` — ідіома «прибрати поле з обʼєкта».
      // Без ignoreRestSiblings правило вимагало б вигадати, куди діти currency.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
);
