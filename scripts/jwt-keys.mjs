#!/usr/bin/env node
// Ключі підпису access-токенів (#24) у сховищі #11 — `secrets/`, поза git.
//
//   node scripts/jwt-keys.mjs init [dev prod]   пара ES256 + kid + перець; наявне не чіпає
//   node scripts/jwt-keys.mjs rotate dev        overlap: нова пара підписує, стара лише перевіряє
//   node scripts/jwt-keys.mjs retire dev        кінець overlap: стара публічна половина йде
//   node scripts/jwt-keys.mjs fingerprints      kid і відбиток кожного оточення
//
// Розкладка одного оточення:
//
//   secrets/jwt/<env>/private.pem          приватна половина активної пари (PKCS#8)
//   secrets/jwt/<env>/public.pem           публічна половина (SPKI)
//   secrets/jwt/<env>/kid                  її ідентифікатор — іде в заголовок токена
//   secrets/jwt/<env>/previous_public.pem  лише під час overlap: попередня публічна
//   secrets/jwt/<env>/previous_kid         і її kid
//   secrets/jwt/<env>/refresh_pepper       ключ HMAC для хешів refresh-токенів
//
// dev і prod — різні пари й різні перці. Токен, виписаний у dev, prod не
// перевірить: підпис не зійдеться, а kid він не знає. Відбитки обох друкує
// `fingerprints` — README показує їх як доказ, що оточення різні.
//
// Скрипт друкує лише kid і відбиток (SHA-256 від DER публічного ключа) —
// значення ключів не виходять за межі файлів.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENVS = ['dev', 'prod'];

const dirOf = (env) => path.join(ROOT, 'secrets', 'jwt', env);
const file = (env, name) => path.join(dirOf(env), name);
const read = (env, name) => readFileSync(file(env, name), 'utf8').trim();
const write = (env, name, value) => writeFileSync(file(env, name), value, { mode: 0o600 });

/** Той самий відбиток, що в лозі застосунку (src/auth/keys.ts). */
export function fingerprint(publicPem) {
  const der = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** `dev-20261102-3f9a` — оточення, дата випуску, і хвіст, щоб дві ротації за день не зіткнулись. */
function newKid(env) {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `${env}-${day}-${randomBytes(2).toString('hex')}`;
}

function writePair(env) {
  // P-256 — крива ES256 (RFC 7518 §3.4).
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  write(env, 'private.pem', privateKey);
  write(env, 'public.pem', publicKey);
  const kid = newKid(env);
  write(env, 'kid', kid);
  return kid;
}

function init(env) {
  mkdirSync(dirOf(env), { recursive: true, mode: 0o700 });
  // Пара цілком або ніяк: обірваний посередині init не має лишити приватний
  // ключ без публічного чи без kid.
  const created = !['private.pem', 'public.pem', 'kid'].every((name) => existsSync(file(env, name)));
  if (created) writePair(env);
  if (!existsSync(file(env, 'refresh_pepper'))) write(env, 'refresh_pepper', randomBytes(32).toString('hex'));
  console.log(`${env.padEnd(4)} kid=${read(env, 'kid')} fp=${fingerprint(read(env, 'public.pem'))} (${created ? 'створено' : 'уже було'})`);
}

/**
 * Ротація з overlap. Нова пара одразу підписує, а стара публічна половина
 * лишається в наборі перевірки — інакше кожен access-токен, виданий до
 * ротації, отримав би 401 посеред сесії. Стару приватну половину видаляємо
 * одразу: підписувати нею вже ніхто не має.
 */
function rotate(env) {
  if (!existsSync(file(env, 'private.pem'))) throw new Error(`${env}: ключів ще немає — спершу init`);
  if (existsSync(file(env, 'previous_kid'))) {
    throw new Error(`${env}: попередній overlap ще триває (${read(env, 'previous_kid')}) — спершу retire`);
  }
  const oldKid = read(env, 'kid');
  renameSync(file(env, 'public.pem'), file(env, 'previous_public.pem'));
  write(env, 'previous_kid', oldKid);
  rmSync(file(env, 'private.pem'));
  const kid = writePair(env);
  console.log(`${env}: ${oldKid} → ${kid}. Підписує ${kid}, перевіряються обидва.`);
  console.log('Перезапусти застосунок (npm run start:vault), а через 10 хв (TTL access) — retire.');
}

/** Кінець overlap: усі токени старого ключа вже протухли — його можна прибрати. */
function retire(env) {
  if (!existsSync(file(env, 'previous_kid'))) {
    console.log(`${env}: overlap немає — прибирати нічого`);
    return;
  }
  const oldKid = read(env, 'previous_kid');
  rmSync(file(env, 'previous_public.pem'));
  rmSync(file(env, 'previous_kid'));
  console.log(`${env}: ${oldKid} прибрано з набору перевірки. Перезапусти застосунок.`);
}

function fingerprints() {
  for (const env of ENVS) {
    if (!existsSync(file(env, 'public.pem'))) {
      console.log(`${env.padEnd(4)} — ключів немає (npm run keys:init)`);
      continue;
    }
    console.log(`${env.padEnd(4)} kid=${read(env, 'kid')} fp=${fingerprint(read(env, 'public.pem'))}`);
    if (existsSync(file(env, 'previous_kid'))) {
      console.log(`${''.padEnd(4)} previous kid=${read(env, 'previous_kid')} fp=${fingerprint(read(env, 'previous_public.pem'))} (overlap)`);
    }
  }
}

const [cmd, ...args] = process.argv.slice(2);
const envs = args.length > 0 ? args : ENVS;
for (const env of envs) {
  if (!ENVS.includes(env)) {
    console.error(`невідоме оточення '${env}' (є: ${ENVS.join(', ')})`);
    process.exit(2);
  }
}

try {
  switch (cmd) {
    case 'init':
      envs.forEach(init);
      break;
    case 'rotate':
      rotate(args[0] ?? 'dev');
      break;
    case 'retire':
      retire(args[0] ?? 'dev');
      break;
    case 'fingerprints':
      fingerprints();
      break;
    default:
      console.error('використання: jwt-keys.mjs init|rotate|retire|fingerprints [dev|prod]');
      process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
