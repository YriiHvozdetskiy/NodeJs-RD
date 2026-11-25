// Спільне для demo:failover | demo:alb | demo:nat (#31).
//
// Демо викликають ті самі команди aws CLI, що стоять в умові ДЗ і в teardown.yml, —
// лише з розбором JSON. Креденшели не читаються з коду: їх кладе в оточення
// scripts/with-secrets.sh aws. Кожне демо друкує `ключ=значення` і дописує свої
// ключі в evidence/demos.txt (старі значення тих самих ключів замінюються).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STACK_DIR = path.join(ROOT, "infra", "demo");
const EVIDENCE = path.join(ROOT, "evidence", "demos.txt");

// Регіон — з конфігу стеку demo, як у scripts/aws-empty.sh.
export const REGION = readFileSync(path.join(STACK_DIR, "Pulumi.demo.yaml"), "utf8")
  .match(/^ {2}aws:region: *([a-z0-9-]+)/m)?.[1];
if (!REGION) throw new Error("aws:region не знайдено в infra/demo/Pulumi.demo.yaml");

// Системний бінарник, якщо він є, інакше обгортка-контейнер із scripts/bin/ (як tool_path у tools.sh).
function tool(name) {
  const own = path.join(ROOT, "scripts", "bin", name);
  const found = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  return found && found !== own ? found : own;
}
const AWS_BIN = tool("aws");
const PULUMI_BIN = tool("pulumi");

export function aws(args, region = REGION) {
  const out = execFileSync(AWS_BIN, [...args, "--region", region, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return out.trim() ? JSON.parse(out) : {};
}

// pulumi по стеку demo. inherit — живий вивід up у термінал; інакше stdout повертається рядком.
export function pulumi(args, { inherit = false } = {}) {
  const started = Date.now();
  const r = spawnSync(PULUMI_BIN, [...args, "--stack", "demo", "--cwd", STACK_DIR, "--non-interactive"], {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "inherit"],
    env: { ...process.env, PULUMI_SKIP_UPDATE_CHECK: "true" },
  });
  if (r.status !== 0) throw new Error(`pulumi ${args.join(" ")}: exit ${r.status}`);
  return { stdout: (r.stdout ?? "").trim(), seconds: (Date.now() - started) / 1000 };
}

export function stackOutput(key) {
  const { stdout } = pulumi(["stack", "output", "--json"]);
  const outputs = stdout ? JSON.parse(stdout) : {};
  return outputs[key];
}

export function requireOutput(key) {
  const value = stackOutput(key);
  if (!value) throw new Error(`stack demo не має виходу ${key}: спершу npm run up:demo`);
  return String(value);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const round1 = (x) => Math.round(x * 10) / 10;
export const elapsed = (t0) => round1((Date.now() - t0) / 1000);

// Друкує ключі й записує їх у evidence/demos.txt, замінивши попередні значення тих самих ключів.
export function record(map) {
  console.log("");
  for (const [k, v] of Object.entries(map)) console.log(`${k}=${v}`);
  mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  const keys = new Set(Object.keys(map));
  const kept = existsSync(EVIDENCE)
    ? readFileSync(EVIDENCE, "utf8").split("\n").filter((l) => l && !keys.has(l.split("=")[0]))
    : [];
  const fresh = Object.entries(map).map(([k, v]) => `${k}=${v}`);
  writeFileSync(EVIDENCE, [...kept, ...fresh].join("\n") + "\n");
}

// Перевірка результату — числа, пораховані з того, що реально сталося, а не надруковані як очікувані.
export function makeChecks() {
  let pass = 0;
  let total = 0;
  return {
    check(name, ok, detail) {
      total += 1;
      if (ok) pass += 1;
      console.log(`  ${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : `: ${detail}`}`);
    },
    summary() {
      console.log(`\nПЕРЕВІРКИ: ${pass}/${total}`);
      if (pass !== total) process.exitCode = 1;
    },
  };
}
