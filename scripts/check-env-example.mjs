// Звіряє .env.example зі схемою env — `npm run check:env`.
//
// Джерело правди — ключі zod-схеми, а не файл. Правило конвенції: додав змінну
// в схему → додай у .env.example у тому ж коміті, інакше цей скрипт (а з ним
// і CI) червоний.
//
// Схема читається зі ЗБІРКИ (dist/), а не з .ts: скрипт лишається звичайним
// Node без транспіляції, і водночас звіряється саме з тим кодом, який
// виконуватиметься. Тому `check:env` спершу білдить.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { parse } from 'dotenv';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(root, 'dist', 'config', 'env.schema.js');
const examplePath = path.join(root, '.env.example');

let envSchema;
try {
  ({ envSchema } = require(schemaPath));
} catch (err) {
  console.error(`✗ Не вдалось прочитати схему з ${path.relative(root, schemaPath)}`);
  console.error(`  ${err.message}`);
  console.error('  Спершу збери проєкт: npm run build');
  process.exit(1);
}

const raw = readFileSync(examplePath, 'utf8');
const schemaKeys = Object.keys(envSchema.shape).sort();
const fileKeys = Object.keys(parse(raw)).sort();

const missing = schemaKeys.filter((key) => !fileKeys.includes(key)); // є в схемі, нема у файлі
const extra = fileKeys.filter((key) => !schemaKeys.includes(key)); // є у файлі, нема в схемі

// Друга половина конвенції: змінна без пояснення нічим не краща за відсутню.
// Коментарем вважається найближчий непорожній рядок вище — саме так файл і читають.
const lines = raw.split('\n');
const undocumented = fileKeys.filter((key) => {
  const index = lines.findIndex((line) => line.trimStart().startsWith(`${key}=`));
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    return !line.startsWith('#');
  }
  return true;
});

if (missing.length || extra.length || undocumented.length) {
  if (missing.length) console.error(`✗ Нема в .env.example: ${missing.join(', ')}`);
  if (extra.length) console.error(`✗ Зайве у .env.example (у схемі відсутнє): ${extra.join(', ')}`);
  if (undocumented.length) console.error(`✗ Без коментаря у .env.example: ${undocumented.join(', ')}`);
  process.exit(1);
}

console.log(`✓ .env.example синхронний зі схемою (${schemaKeys.length} змінних, усі з коментарями)`);
