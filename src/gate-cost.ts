/**
 * Гейт вартості (#32): план Pulumi → гроші (src/mapping.ts) → порівняння з бюджетом.
 *
 *   PLAN_JSON=plan.json COST_BUDGET_USD=0      npm run gate:cost   # gate=fail, exit 1
 *   PLAN_JSON=plan.json COST_BUDGET_USD=999999 npm run gate:cost   # gate=pass, exit 0
 *   PLAN_JSON=plan.json COST_BASE_PLAN_JSON=base-plan.json npm run gate:cost   # як у конвеєрі
 *
 * Бюджет — один із двох:
 *   • COST_BUDGET_USD — абсолютне число (так його перевіряє грейдер);
 *   • COST_BASE_PLAN_JSON — план бази PR. Тоді бюджет = вартість бази +
 *     max(COST_DELTA_USD, COST_DELTA_PCT % бази), за замовчуванням $10 або 20 %.
 *     Гейт реагує на ЗМІНУ, а не на суму: абсолютний ліміт зробив би червоним
 *     кожен наступний PR після першого дорогого ресурсу.
 *
 * Обидва числа РАХУЮТЬСЯ з планів тим самим перекладачем — надрукованого
 * висновку тут немає. Код виходу: 0 — pass, 1 — fail, 2 — гейт не відпрацював.
 * Обхід — лейбл PR (README, cost-gate-bypass-label); його читає конвеєр, не цей скрипт.
 */
import { readFileSync } from 'node:fs';
import { type PlanCost, planCost } from './mapping';

const usd = (n: number): string => n.toFixed(2);

function readPlan(file: string): PlanCost {
  return planCost(JSON.parse(readFileSync(file, 'utf8')));
}

function numberFrom(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name}: не задано`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name}: '${raw}' — не число`);
  return n;
}

function main(): number {
  const planFile = process.env.PLAN_JSON;
  if (!planFile) throw new Error('PLAN_JSON: не задано — шлях до виводу `pulumi preview --json`');
  const head = readPlan(planFile);

  for (const l of head.lines) {
    console.log(
      `# ${l.type.split(':').pop()} ${l.name} ×${l.replicas}: ${l.vcpu} vCPU, ` +
        `${l.memoryGb.toFixed(3)} GiB → $${usd(l.monthlyUsd)}/міс`,
    );
  }
  for (const name of head.unpriced) console.log(`# ${name}: без resources.requests — у плані $0, у вузла ні`);

  let budget: number;
  if (process.env.COST_BUDGET_USD !== undefined && process.env.COST_BUDGET_USD !== '') {
    budget = numberFrom('COST_BUDGET_USD');
  } else if (process.env.COST_BASE_PLAN_JSON) {
    const base = readPlan(process.env.COST_BASE_PLAN_JSON).totalUsd;
    const headroom = Math.max(numberFrom('COST_DELTA_USD', 10), (base * numberFrom('COST_DELTA_PCT', 20)) / 100);
    budget = base + headroom;
    console.log(`base-usd=${usd(base)}`);
    console.log(`delta-usd=${usd(head.totalUsd - base)}`);
    console.log(`headroom-usd=${usd(headroom)}`);
  } else {
    throw new Error('немає бюджету: задайте COST_BUDGET_USD або COST_BASE_PLAN_JSON');
  }

  // Порівнюємо в центах: дробові долари з плаваючою комою дали б «перевищено
  // на 0.0000001» там, де суми рівні.
  const pass = Math.round(head.totalUsd * 100) <= Math.round(budget * 100);
  console.log(`budget-usd=${usd(budget)}`);
  console.log(`plan-usd=${usd(head.totalUsd)}`);
  console.log(`gate=${pass ? 'pass' : 'fail'}`);
  return pass ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`gate:cost: ${err instanceof Error ? err.message : String(err)}`);
  console.log('gate=error');
  process.exitCode = 2;
}
