// npm run demo:failover (#31, пункт 9). Контракт: az-before, az-after, failover-seconds, event.
//
// Multi-AZ — це процедура перемикання на standby, а не бекап і не репліка для читання.
// `reboot-db-instance --force-failover` — керований перемикач: міряємо процедуру, не інцидент.
// Сам failover рядка в рахунку не додає: standby уже оплачено в ціні Multi-AZ.
//
// Де база «зараз», питаємо в DNS: ім'я RDS після перемикання вказує на IP standby, а його
// мережевий інтерфейс лежить у конкретній AZ. Поле AvailabilityZone у describe-db-instances
// оновлюється із запізненням на хвилини — його друкуємо окремо, для порівняння.
import { resolve4 } from "node:dns/promises";
import { aws, requireOutput, record, makeChecks, sleep, elapsed } from "./lib/aws.mjs";

const id = requireOutput("dbIdentifier");
const host = requireOutput("dbAddress");
const describe = () => aws(["rds", "describe-db-instances", "--db-instance-identifier", id]).DBInstances[0];

async function azByDns() {
  try {
    const [ip] = await resolve4(host);
    const enis = aws(["ec2", "describe-network-interfaces",
      "--filters", `Name=addresses.private-ip-address,Values=${ip}`]).NetworkInterfaces;
    return enis[0]?.AvailabilityZone;
  } catch {
    return undefined; // DNS недоступний (фільтр мережі) — тоді лишається describe
  }
}

const checks = makeChecks();
const before = describe();
if (before.DBInstanceStatus !== "available") {
  // --force-failover на інстансі в modifying/backing-up не піде. Чекати, а не перезапускати.
  console.error(`${id}: статус ${before.DBInstanceStatus}, а не available — дочекайся і запусти ще раз`);
  process.exit(1);
}
const dnsBefore = await azByDns();
const azBefore = dnsBefore ?? before.AvailabilityZone;
console.log(`${id}: available, AZ ${azBefore} (${dnsBefore ? "за DNS" : "за describe"}), standby ${before.SecondaryAvailabilityZone}`);

const t0 = Date.now();
const since = new Date(t0 - 60_000).toISOString();
const events = () => aws(["rds", "describe-events", "--source-type", "db-instance",
  "--source-identifier", id, "--start-time", since]).Events;
const findEvent = (re) => events().find((e) => re.test(e.Message));

aws(["rds", "reboot-db-instance", "--db-instance-identifier", id, "--force-failover"]);
console.log("reboot --force-failover відправлено");

// Кінець вправи — подія «failover completed» і статус available, а не лише статус.
let now = describe();
let completed;
while (Date.now() - t0 < 900_000) {
  await sleep(5000);
  now = describe();
  completed = findEvent(/failover completed/i);
  console.log(`  ${elapsed(t0)} с · ${now.DBInstanceStatus}${completed ? " · failover completed" : ""}`);
  if (completed && now.DBInstanceStatus === "available") break;
}
const failoverSeconds = elapsed(t0);
const started = findEvent(/failover started/i);
const awsSeconds = started && completed
  ? (Date.parse(completed.Date) - Date.parse(started.Date)) / 1000
  : -1;

// DNS має TTL у секунди: даємо хвилину на те, щоб ім'я переїхало на нову IP.
let azAfter = await azByDns();
const dnsDeadline = Date.now() + 60_000;
while (dnsBefore && azAfter === azBefore && Date.now() < dnsDeadline) {
  await sleep(5000);
  azAfter = await azByDns();
}
if (!azAfter) {
  console.log("DNS недоступний — чекаю, поки describe-db-instances покаже нову AZ (до 15 хв)");
  const deadline = Date.now() + 900_000;
  while (describe().AvailabilityZone === azBefore && Date.now() < deadline) await sleep(15_000);
  azAfter = describe().AvailabilityZone;
}
const azDescribe = describe().AvailabilityZone;

checks.check("AZ змінилась", azAfter !== azBefore, `${azBefore} -> ${azAfter}`);
checks.check("статус після", now.DBInstanceStatus === "available", now.DBInstanceStatus);
checks.check("подія в журналі RDS", Boolean(completed), completed?.Message);
// «Typically 60–120 seconds» — спостереження, а не гарантія: вихід за вилку не провал, а рядок у README.
const inDocsRange = failoverSeconds >= 60 && failoverSeconds <= 120;
console.log(`  · ${failoverSeconds} с ${inDocsRange ? "у вилці" : "ПОЗА вилкою"} 60–120 с із документації RDS`);

record({
  "az-before": azBefore,
  "az-after": azAfter ?? "",
  "failover-seconds": failoverSeconds,
  "failover-aws-event-seconds": awsSeconds,
  "az-describe-after": azDescribe,
  event: (completed?.Message ?? "").replaceAll("=", " "),
  "event-time": completed?.Date ?? "",
});
checks.summary();
