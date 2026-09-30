/**
 * Тести запускаються зі СКОМПІЛЬОВАНОГО dist-test/ (tsc → jest), без
 * трансформерів на льоту: esbuild-транспілятори не емітять декоратор-метадані,
 * і Nest без них не збере DI-граф. `npm run build:test` компілює src/ і test/
 * разом за tsconfig.test.json.
 */

// Ядро Pact (Rust) шле анонімну телеметрію в google-analytics на кожен прогін:
// у CI це зайвий вихідний запит, в ізольованій мережі — таймаут. Ставиться тут,
// а не в тесті: jest дає кожному тест-файлу КОПІЮ process.env, і нативне ядро
// присвоєння з тесту не побачило б. Той самий принцип, що з @scarf/scarf у
// pnpm-workspace.yaml.
process.env.PACT_DO_NOT_TRACK ??= 'true';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/dist-test/test/**/*.test.js'],
  transform: {},
  // Без цього рядка Jest 30 вибирає репортер сам — за змінними оточення
  // (detectAgent() у @jest/core), і в частині середовищ вмикає компактний
  // репортер, який не друкує ні PASS, ні назв тестів, ні ✓. Явний 'default'
  // робить вивід однаковим у терміналі, у `| tee` і в CI.
  reporters: ['default'],
  verbose: true,
  // Кожен воркер піднімав би власні контейнери. Один воркер — файли йдуть по
  // черзі, і в Docker одночасно живе один Postgres на файл.
  maxWorkers: 1,
  // Перший прогін на свіжій машині тягне образи postgres:16-alpine і ryuk.
  testTimeout: 120_000,
};
