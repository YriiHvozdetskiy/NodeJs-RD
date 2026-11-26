#!/usr/bin/env node
// План Pulumi без значень K8s Secret (#32): stdin → stdout.
//
//   bash scripts/with-secrets.sh kind bash scripts/infra.sh plan | node scripts/ci/redact-plan.mjs > plan.json
//
// `pulumi preview --json` друкує inputs кожного ресурсу, і поле `data` у
// Secret — відкритим base64, хоча в програмі воно загорнуте в pulumi.secret():
// у стані Pulumi воно зашифроване, у JSON-плані — ні. Виміряно на першому
// прогоні конвеєра: secret-in-plan=4 — пароль БД, пароль Redis, ключ підпису
// JWT і перець. plan.json іде в артефакт публічного репозиторію, тож сирий
// вивід preview на диск не потрапляє: цей фільтр стоїть у тому самому конвеєрі.
//
// Замінюються `data` і `stringData` кожного ресурсу типу Secret — у inputs і
// outputs, у newState і oldState. Гейту вартості вони не потрібні: він читає
// requests подів. Чи замінено все — перевіряє наступний крок,
// scripts/ci/secret-count.mjs, за самими значеннями.
const SECRET_TYPE = 'kubernetes:core/v1:Secret';
const FIELDS = ['data', 'stringData'];

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const plan = JSON.parse(raw);

let redacted = 0;
for (const step of plan.steps ?? []) {
  for (const stateKey of ['newState', 'oldState']) {
    const state = step[stateKey];
    if (state?.type !== SECRET_TYPE) continue;
    for (const half of ['inputs', 'outputs']) {
      for (const field of FIELDS) {
        const fields = state[half]?.[field];
        if (fields && typeof fields === 'object') {
          for (const key of Object.keys(fields)) fields[key] = '[secret]';
          redacted++;
        } else if (typeof fields === 'string' && fields !== '[secret]') {
          state[half][field] = '[secret]';
          redacted++;
        }
      }
    }
  }
}

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
console.error(`redact-plan: замінено полів Secret — ${redacted}`);
