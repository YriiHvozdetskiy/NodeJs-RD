#!/usr/bin/env node
// demo:gates (#32) — чотири сходинки гейтів якості, кожна в обидва боки.
//
//   npm run demo:gates
//
// Для кожної сходинки той самий скрипт гейта (scripts/gates/*.sh, scan.sh) біжить
// двічі: на коректному вході і на зумисне зламаному. Зламаний вхід — справжній
// дефект того класу, який сходинка ловить, підкладений у КОПІЮ дерева в
// тимчасовій теці. Репозиторій не змінюється.
//
//   types     tsc + eslint       копія src/ з одруковкою в типі (`Strng`)
//   contract  oasdiff            спека з прибраною операцією getProduct
//   arch      dependency-cruiser копія src/ з імпортом catalog → orders
//   image     npm run scan       той самий образ, поріг SCAN_MAX=-1
//
// stdout — лише рядки `<сходинка>-ok=<код>` і `<сходинка>-broken=<код>` плюс
// підсумок; весь вивід інструментів іде в stderr. Код — реальний код виходу
// процесу гейта, не надрукований висновок. Сходинка двобічна, коли ok=0 і broken≠0.
//
// Мережа не потрібна, кластер теж. Потрібен Docker: oasdiff і Trivy — образами.
// Немає образу застосунку — скрипт збирає його (npm run image:build, кілька хвилин).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env.IMAGE ?? 'marketplace-api:hw28';
const work = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), 'demo-gates-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

/** Запускає команду, увесь її вивід — у stderr. Повертає код виходу процесу. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', process.stderr, process.stderr], ...opts });
  if (r.error) {
    console.error(`demo:gates: ${cmd}: ${r.error.message}`);
    return 127;
  }
  // Убитий сигналом процес — теж «ні», але не нуль: status тоді null.
  return r.status ?? 128;
}

/**
 * Копія дерева для зламаного входу: src, test і конфіги — файлами, node_modules —
 * посиланням (сотні мегабайт копіювати нема чого, а версії інструментів ті самі).
 */
function treeCopy(name) {
  const dir = path.join(work, name);
  for (const entry of ['src', 'test', 'tsconfig.json', 'tsconfig.test.json', 'eslint.config.mjs', '.dependency-cruiser.cjs', 'package.json']) {
    cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

const results = [];
function rung(name, ok, broken) {
  console.error(`\n── ${name}: коректний вхід ──`);
  const okCode = ok();
  console.error(`\n── ${name}: зламаний вхід ──`);
  const brokenCode = broken();
  console.log(`${name}-ok=${okCode}`);
  console.log(`${name}-broken=${brokenCode}`);
  results.push({ name, okCode, brokenCode });
}

if (!existsSync(path.join(ROOT, 'node_modules', '.bin', 'tsc'))) {
  console.error('demo:gates: немає node_modules — спершу npm ci');
  process.exit(2);
}

// ── 1. Типи й стиль ─────────────────────────────────────────────────────────
// Дефект — новий файл у src/catalog з типом `Strng` замість `string`: таке
// компілятор ловить, а рев'ювер на диффі в сотню рядків легко пропускає.
const typesBroken = treeCopy('types-broken');
writeFileSync(
  path.join(typesBroken, 'src/catalog/gate-probe.ts'),
  "// demo:gates: зумисна одруковка в типі\nexport const currencyLabel: Strng = 'UAH';\n",
);
rung(
  'types',
  () => run('bash', ['scripts/gates/types.sh', ROOT]),
  () => run('bash', ['scripts/gates/types.sh', typesBroken]),
);

// ── 2. Контракт ─────────────────────────────────────────────────────────────
// База — спека репо, зібрана в один JSON (redocly bundle). Сумісна зміна —
// новий шлях: старі клієнти його не знають і не помічають. Ламаюча — зникла
// операція getProduct: клієнт, що відкриває картку товару, отримає 404.
const specDir = path.join(work, 'spec');
const base = path.join(specDir, 'base.json');
// REDOCLY_TELEMETRY=off: інакше CLI шле телеметрію в otel.cloud.redocly.com, а
// демо обіцяє роботу без мережі.
let contractReady =
  run(path.join(ROOT, 'node_modules/.bin/redocly'), ['bundle', 'openapi/openapi.yaml', '--ext', 'json', '-o', base], {
    env: { ...process.env, REDOCLY_TELEMETRY: 'off' },
  }) === 0;
if (contractReady) {
  const spec = JSON.parse(readFileSync(base, 'utf8'));
  const compatible = structuredClone(spec);
  compatible.paths['/products/{productId}/availability'] = {
    get: {
      operationId: 'getProductAvailability',
      summary: 'Залишок товару (нова операція — сумісна зміна)',
      parameters: [{ name: 'productId', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } },
    },
  };
  const breaking = structuredClone(spec);
  if (breaking.paths?.['/products/{productId}']?.get) {
    delete breaking.paths['/products/{productId}'].get;
  } else {
    console.error('demo:gates: у спеці немає GET /products/{productId} — ламаючу зміну нема з чого зробити');
    contractReady = false;
  }
  writeFileSync(path.join(specDir, 'compatible.json'), JSON.stringify(compatible));
  writeFileSync(path.join(specDir, 'breaking.json'), JSON.stringify(breaking));
}
rung(
  'contract',
  () => (contractReady ? run('bash', ['scripts/gates/contract.sh', base, path.join(specDir, 'compatible.json')]) : 2),
  () => (contractReady ? run('bash', ['scripts/gates/contract.sh', base, path.join(specDir, 'breaking.json')]) : 2),
);

// ── 3. Архітектура ──────────────────────────────────────────────────────────
// Дефект — каталог імпортує сервіс замовлень. Компілюється, тести зелені, і
// саме тому його ловить окремий інструмент, а не tsc.
const archBroken = treeCopy('arch-broken');
writeFileSync(
  path.join(archBroken, 'src/catalog/gate-probe.ts'),
  "// demo:gates: каталог лізе в замовлення\nimport { OrdersService } from '../orders/orders.service';\nexport const ordersOf = OrdersService;\n",
);
rung(
  'arch',
  () => run('bash', ['scripts/gates/arch.sh', ROOT]),
  () => run('bash', ['scripts/gates/arch.sh', archBroken]),
);

// ── 4. Образ ────────────────────────────────────────────────────────────────
// Той самий образ і той самий npm run scan з #28 — різний лише поріг.
// SCAN_MAX=-1: знахідок завжди ≥ 0, тож gate=fail за будь-якої бази Trivy.
if (run('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }) !== 0) {
  console.error(`\ndemo:gates: образу ${IMAGE} немає — збираю (npm run image:build, кілька хвилин)`);
  const token = path.join(ROOT, '.npm_token');
  // Токен етапу збірки — приманка з #28 (приватного реєстру немає). Файл у .gitignore.
  if (!existsSync(token)) writeFileSync(token, `npm_decoy_demo_gates_${process.pid}`, { mode: 0o600 });
  run('bash', ['scripts/image-build.sh']);
}
rung(
  'image',
  () => run('bash', ['scripts/scan.sh'], { env: { ...process.env, IMAGE, SCAN_MAX: '99999' } }),
  () => run('bash', ['scripts/scan.sh'], { env: { ...process.env, IMAGE, SCAN_MAX: '-1' } }),
);

const oneSided = results.filter((r) => r.okCode !== 0 || r.brokenCode === 0);
for (const r of oneSided) console.log(`# однобічна: ${r.name} ok=${r.okCode} broken=${r.brokenCode}`);
console.log(`gates=${results.length}`);
console.log(`one-sided=${oneSided.length}`);
process.exitCode = oneSided.length === 0 ? 0 : 1;
