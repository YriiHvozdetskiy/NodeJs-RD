#!/usr/bin/env node
// ID-токен GitHub Actions у файл (#32) — вхід для scripts/oidc-gate.mjs у конвеєрі.
//
//   node scripts/oidc-token.mjs --policy oidc/policy.json --out "$RUNNER_TEMP/oidc.jwt"
//
// Раннер дає джобі дві змінні, лише якщо в неї є `permissions: id-token: write`:
// адресу видачі й одноразовий bearer для неї. Без дозволу змінних немає — і це
// найчастіше падіння ДЗ: локально все працює, а в джобі токена нема звідки взяти.
//
// audience — з умови гейта: токен виписується саме для нього, і чужий
// одержувач (інший сервіс із тим самим видавцем) його не прийме.
//
// Токен іде у файл 0600 і НІКУДИ більше: ні в stdout, ні в GITHUB_OUTPUT, ні в
// GITHUB_ENV. Маскування раннера ловить лише точне входження зареєстрованого
// значення, а ID-токен ніхто не реєстрував — надрукований, він лишився б у лозі
// відкритим текстом на весь строк життя.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { policy: { type: 'string' }, out: { type: 'string' } } });
if (!args.policy || !args.out) {
  console.error('usage: oidc-token.mjs --policy <policy.json> --out <file>');
  process.exit(2);
}

const { ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env;
if (!requestUrl || !bearer) {
  console.error('oidc-token: немає ACTIONS_ID_TOKEN_REQUEST_URL — у джоби немає `permissions: id-token: write`');
  process.exit(2);
}

const { audience } = JSON.parse(readFileSync(args.policy, 'utf8'));
const url = new URL(requestUrl);
url.searchParams.set('audience', audience);

const res = await fetch(url, {
  headers: { Authorization: `bearer ${bearer}`, Accept: 'application/json' },
  signal: AbortSignal.timeout(10_000),
});
if (!res.ok) {
  // Тіло відповіді не друкуємо: в успішній відповіді воно і є токеном.
  console.error(`oidc-token: видача відповіла HTTP ${res.status}`);
  process.exit(1);
}
const { value } = await res.json();
writeFileSync(args.out, value, { mode: 0o600 });
console.log(`token-file=${args.out}`);
console.log(`token-audience=${audience}`);
