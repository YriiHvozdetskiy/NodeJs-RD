/**
 * Перекладач плану Pulumi в гроші (#32) — вхід гейта вартості (src/gate-cost.ts).
 *
 * Маніфести Kubernetes самі нічого не коштують. Коштує те, що під ними: CPU і
 * памʼять, які под резервує у вузла (`resources.requests`). Тому ціна ресурсу
 * плану — requests його подів × кількість реплік × погодинна ставка × 730 год.
 *
 * Ставка — AWS Fargate, eu-central-1 (той самий регіон, що в #31): за неї ці
 * поди й крутилися б, переїдь kind у хмару. Звідки числа і дата — README,
 * розділ CI/CD → «Гейт вартості».
 *
 * Що НЕ рахується, і чому:
 *   • Job / CronJob — живуть хвилини (міграції), місячної ставки в них немає;
 *   • Service, Secret, Namespace, PDB, HPA — обʼєкти API, не ресурси вузла;
 *   • limits — це стеля, а не резерв: платять за requests;
 *   • HPA може підняти репліки до maxReplicas — план показує spec.replicas,
 *     тобто «скільки зараз», а не найгірший випадок.
 */

/** Ставки на годину, USD. Джерело й дата знімка — README, розділ CI/CD. */
export const RATES = {
  vcpuHourUsd: 0.04656,
  gbHourUsd: 0.00511,
} as const;

/** 365 × 24 / 12 — та сама місячна база, що в калькуляторі AWS. */
export const HOURS_PER_MONTH = 730;

/** Типи, у яких є поди з постійним резервом, і де в них лежить шаблон пода. */
const WORKLOADS: Record<string, 'template' | 'pod'> = {
  'kubernetes:apps/v1:Deployment': 'template',
  'kubernetes:apps/v1:StatefulSet': 'template',
  'kubernetes:apps/v1:ReplicaSet': 'template',
  'kubernetes:core/v1:Pod': 'pod',
};

/**
 * Кроки плану, після яких ресурс ІСНУЄ. delete/discard — зникає, read — чужий
 * ресурс, яким стек не керує. `same` теж рахується: preview після up показує
 * весь стек як same, і без нього вартість незмінного стеку була б $0.
 */
const LIVE_OPS = new Set(['create', 'update', 'same', 'replace', 'create-replacement', 'import']);

export interface CostLine {
  type: string;
  name: string;
  replicas: number;
  vcpu: number;
  memoryGb: number;
  monthlyUsd: number;
}

export interface PlanCost {
  totalUsd: number;
  lines: CostLine[];
  /** Workload без requests: коштує 0 у плані, але не у вузла — варто бачити. */
  unpriced: string[];
}

/** "100m" → 0.1, "0.5" → 0.5, 2 → 2. Порожньо — 0 (немає резерву). */
export function parseCpu(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value === '') return 0;
  const milli = /^(\d+(?:\.\d+)?)m$/.exec(value);
  if (milli) return Number(milli[1]) / 1000;
  const cores = Number(value);
  if (!Number.isFinite(cores)) throw new Error(`cpu: не розумію '${value}'`);
  return cores;
}

const MEMORY_UNITS: Record<string, number> = {
  '': 1,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
};

/** "160Mi" → 0.15625 (GiB), "1G" → 0.93…; Fargate тарифікує памʼять у GiB-годинах. */
export function parseMemoryGb(value: unknown): number {
  if (typeof value === 'number') return value / 2 ** 30;
  if (typeof value !== 'string' || value === '') return 0;
  const m = /^(\d+(?:\.\d+)?(?:e\d+)?)([kKMGT]i?)?$/.exec(value);
  if (!m || !((m[2] ?? '') in MEMORY_UNITS)) throw new Error(`memory: не розумію '${value}'`);
  return (Number(m[1]) * MEMORY_UNITS[m[2] ?? '']) / 2 ** 30;
}

/** Безпечний спуск по невідомому JSON: plan.json — зовнішній вхід. */
function dig(value: unknown, ...keys: string[]): unknown {
  let cur = value;
  for (const key of keys) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = Reflect.get(cur, key);
  }
  return cur;
}

/** Ціна одного кроку плану; null — крок не про workload або ресурс не житиме. */
function priceStep(step: unknown): { line: CostLine | null; unpriced?: string } {
  const op = dig(step, 'op');
  const state = dig(step, 'newState');
  const type = dig(state, 'type');
  if (typeof op !== 'string' || !LIVE_OPS.has(op) || typeof type !== 'string' || !(type in WORKLOADS)) {
    return { line: null };
  }
  const urn = String(dig(step, 'urn') ?? dig(state, 'urn') ?? '');
  const name = urn.split('::').pop() ?? urn;
  const inputs = dig(state, 'inputs');
  const podSpec = WORKLOADS[type] === 'template' ? dig(inputs, 'spec', 'template', 'spec') : dig(inputs, 'spec');
  // replicas не задано — Kubernetes ставить 1. Невідоме на preview значення
  // (рядок-заглушка Pulumi) теж рахуємо як 1, а не як 0: гейт не має дешевшати від невідомого.
  const rawReplicas = WORKLOADS[type] === 'template' ? dig(inputs, 'spec', 'replicas') : 1;
  const replicas = typeof rawReplicas === 'number' ? rawReplicas : 1;

  const containers = dig(podSpec, 'containers');
  let vcpu = 0;
  let memoryGb = 0;
  for (const c of Array.isArray(containers) ? containers : []) {
    vcpu += parseCpu(dig(c, 'resources', 'requests', 'cpu'));
    memoryGb += parseMemoryGb(dig(c, 'resources', 'requests', 'memory'));
  }
  const monthlyUsd = replicas * (vcpu * RATES.vcpuHourUsd + memoryGb * RATES.gbHourUsd) * HOURS_PER_MONTH;
  return {
    line: { type, name, replicas, vcpu, memoryGb, monthlyUsd },
    unpriced: vcpu === 0 && memoryGb === 0 ? name : undefined,
  };
}

/** Місячна вартість стеку за планом `pulumi preview --json`. */
export function planCost(plan: unknown): PlanCost {
  const steps = dig(plan, 'steps');
  if (!Array.isArray(steps)) throw new Error('plan.json: немає масиву steps — це не вивід `pulumi preview --json`');
  const lines: CostLine[] = [];
  const unpriced: string[] = [];
  for (const step of steps) {
    const { line, unpriced: u } = priceStep(step);
    if (line) lines.push(line);
    if (u) unpriced.push(u);
  }
  return { totalUsd: lines.reduce((sum, l) => sum + l.monthlyUsd, 0), lines, unpriced };
}
