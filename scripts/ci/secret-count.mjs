#!/usr/bin/env node
// Скільки разів значення секретів застосунку трапилось у файлах (#32).
//
//   bash scripts/with-secrets.sh kind node scripts/ci/secret-count.mjs \
//        manifest=evidence/deployment.json plan=evidence/plan.json
//
// Друкує `secret-in-<мітка>=<число>` на кожен файл. Рахує тут, у раннері, бо
// значення знає лише раннер: грейдер бачить файл, а не пароль, — тому сюди
// приїжджає число, а не пошук.
//
// Шукаємо кожне значення у двох формах: як є (так воно лягло б у env[].value)
// і в base64 (так його кладе K8s Secret у `data`). Більше нуля → код 1:
// маніфест або план із паролем усередині — не те, що можна вивантажити
// артефактом публічного репозиторію.
import { readFileSync } from 'node:fs';

/** Значення сховища, які не мають зʼявитись у маніфесті й плані відкритим текстом. */
const NAMES = ['DB_PASSWORD', 'JWT_PRIVATE_KEY', 'REFRESH_TOKEN_PEPPER', 'PULUMI_CONFIG_PASSPHRASE'];

const values = new Set();
for (const name of NAMES) {
  const v = process.env[name];
  if (!v) {
    console.error(`secret-count: ${name} не задано — запускайте через scripts/with-secrets.sh kind`);
    process.exit(2);
  }
  values.add(v);
}
// Пароль Redis живе всередині REDIS_QUEUE_URL — шукаємо і його окремо.
const redisPassword = decodeURIComponent(new URL(process.env.REDIS_QUEUE_URL ?? 'redis://x').password);
if (redisPassword) values.add(redisPassword);

const forms = [...values].flatMap((v) => [v, Buffer.from(v, 'utf8').toString('base64')]);

let total = 0;
for (const arg of process.argv.slice(2)) {
  const [label, file] = arg.split('=');
  const text = readFileSync(file, 'utf8');
  let hits = 0;
  for (const form of forms) {
    for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + form.length)) hits++;
  }
  console.log(`secret-in-${label}=${hits}`);
  total += hits;
}
console.log(`secret-values-checked=${values.size}`);
process.exitCode = total === 0 ? 0 : 1;
