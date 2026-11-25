// npm run demo:nat (#31, пункт 8). Контракт: nat-minutes, nat-billed-hours.
//
// «Each partial NAT Gateway-hour consumed is billed as a full hour.» Піднімаємо NAT за
// прапорцем hw31:withNat і одразу зносимо. Час життя беремо з CreateTime/DeleteTime самого
// AWS, а не з годинника ноутбука. Ціна вправи: $0,052 за білену годину + $0,005 за IPv4.
import { aws, pulumi, requireOutput, stackOutput, record, makeChecks, round1 } from "./lib/aws.mjs";

// Вимір робиться поверх живого стеку demo: без цього `pulumi up` підняв би заодно RDS і ALB.
requireOutput("albDns");

const checks = makeChecks();
const setNat = (on) => pulumi(["config", "set", "hw31:withNat", on ? "true" : "false"]);

let natId;
let upSeconds = -1;
let downSeconds;
try {
  setNat(true);
  upSeconds = pulumi(["up", "--yes", "--skip-preview"], { inherit: true }).seconds;
  natId = stackOutput("natId");
  console.log(`NAT ${natId} піднято за ${round1(upSeconds)} с — зношу одразу`);
} finally {
  // Знести навіть після помилки: забутий NAT — це $0,052/год і ще $0,005 за його адресу.
  setNat(false);
  downSeconds = pulumi(["up", "--yes", "--skip-preview"], { inherit: true }).seconds;
}

if (!natId) {
  console.error("NAT не піднявся — вимірювати нічого");
  process.exit(1);
}
const nat = aws(["ec2", "describe-nat-gateways", "--nat-gateway-ids", natId]).NatGateways[0];
const minutes = (Date.parse(nat.DeleteTime) - Date.parse(nat.CreateTime)) / 60_000;
// Скільки годин білиться — за правилом прайс-листа: будь-яка частина години = година.
const billedHours = Math.ceil(minutes / 60);
console.log(`CreateTime ${nat.CreateTime} · DeleteTime ${nat.DeleteTime} · ${nat.State}`);

checks.check("NAT знесено", nat.State === "deleted", nat.State);
checks.check("жив менше години", minutes < 60, `${round1(minutes)} хв`);
checks.check("білиться як повна година", billedHours === 1, billedHours);

record({
  "nat-id": natId,
  "nat-minutes": round1(minutes),
  "nat-billed-hours": billedHours,
  "nat-up-seconds": round1(upSeconds),
  "nat-down-seconds": round1(downSeconds),
});
checks.summary();
