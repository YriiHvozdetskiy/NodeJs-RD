// npm run demo:alb (#31, пункт 7). Контракт: alb-dns, http-code, target-state.
//
// target-state головніший за код відповіді: нездорова ціль дає 503 — той самий механізм,
// що readiness-проба на #28, тільки питає балансувальник, а не kubelet.
// Друга частина (HW31_ALB_DRAIN=1): /health починає віддавати 503, і ALB сам виводить
// ціль із ротації. Третя — дві Public IPv4 під ALB, яких немає на жодній схемі.
import { aws, requireOutput, record, makeChecks, sleep, elapsed } from "./lib/aws.mjs";

const dns = requireOutput("albDns");
const albArn = requireOutput("albArn");
const tgArn = requireOutput("targetGroupArn");
const fn = requireOutput("targetFunction");

const targetState = () =>
  aws(["elbv2", "describe-target-health", "--target-group-arn", tgArn])
    .TargetHealthDescriptions[0]?.TargetHealth?.State ?? "none";
const httpCode = async (pathname) => {
  try {
    return (await fetch(`http://${dns}${pathname}`, { signal: AbortSignal.timeout(10_000) })).status;
  } catch {
    return 0;
  }
};

const checks = makeChecks();

// Свіжа ціль стає healthy після healthyThreshold × interval = 2 × 35 с.
const t0 = Date.now();
let state = targetState();
while (state !== "healthy" && Date.now() - t0 < 300_000) {
  console.log(`  ${elapsed(t0)} с · target ${state}`);
  await sleep(10_000);
  state = targetState();
}
const code = await httpCode("/");
console.log(`http://${dns}/ → ${code} · target ${state}`);
checks.check("ціль у ротації", state === "healthy", state);
checks.check("ALB відповідає 200", code === 200, code);

// ENI балансувальника: по одному на AZ, і кожен тримає публічну IPv4 за $0,005/год.
const albId = albArn.split(":loadbalancer/")[1]; // app/<name>/<id>
const enis = aws(["ec2", "describe-network-interfaces",
  "--filters", `Name=description,Values=ELB ${albId}`]).NetworkInterfaces;
const publicIpv4 = enis.filter((e) => e.Association?.PublicIp).length;
console.log(`ENI балансувальника: ${enis.length}, з публічною IPv4: ${publicIpv4}`);

let drainSeconds = -1;
if (process.env.HW31_ALB_DRAIN === "1") {
  console.log("HEALTHY=false → /health віддає 503, чекаю, поки ALB виведе ціль");
  aws(["lambda", "update-function-configuration", "--function-name", fn,
    "--environment", "Variables={HEALTHY=false}"]);
  const t1 = Date.now();
  let drained = targetState();
  try {
    while (drained === "healthy" && Date.now() - t1 < 300_000) {
      await sleep(5000);
      drained = targetState();
      console.log(`  ${elapsed(t1)} с · ${drained}`);
    }
    drainSeconds = elapsed(t1);
    const codeDrained = await httpCode("/");
    checks.check("ціль вийшла з ротації", drained === "unhealthy", drained);
    console.log(`  запит під час виведення → ${codeDrained}`);
  } finally {
    // Повертаємо здорову ціль навіть після помилки: інакше стенд лишиться віддавати 503.
    aws(["lambda", "update-function-configuration", "--function-name", fn,
      "--environment", "Variables={HEALTHY=true}"]);
  }
}

record({
  "alb-dns": dns,
  "http-code": code,
  "target-state": state,
  "alb-public-ipv4": publicIpv4,
  ...(drainSeconds >= 0 ? { "alb-drain-seconds": drainSeconds } : {}),
});
checks.summary();
