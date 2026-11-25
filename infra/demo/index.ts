// Стек demo (ДЗ #31): усе, що тарифікується погодинно. Піднімається на час вимірів,
// зноситься того ж вечора — руками (`npm run destroy:demo`) або нічною джобою teardown.yml.
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// Реєструється ДО першого ресурсу: трансформація бачить лише ресурси, оголошені після неї.
// Забутий deletionProtection зупинив би destroy з помилкою, а фінальний снапшот пережив би
// destroy і білився б далі ($0,095/ГіБ-міс) — рахунок, якого немає в стані Pulumi.
pulumi.runtime.registerResourceTransform((args) => {
  if (args.type === "aws:rds/instance:Instance") {
    return { props: { ...args.props, deletionProtection: false, skipFinalSnapshot: true }, opts: args.opts };
  }
  if (args.type === "aws:lb/loadBalancer:LoadBalancer") {
    return { props: { ...args.props, enableDeletionProtection: false }, opts: args.opts };
  }
  return undefined;
});

const cfg = new pulumi.Config("hw31");
// Вимір пункту 8: NAT живе хвилини, тільки поки demo:nat тримає прапорець увімкненим.
const withNat = cfg.getBoolean("withNat") ?? false;

// Пароль бази — зі сховища #11 (secrets/rds_master_password через scripts/with-secrets.sh),
// а не з конфігу стеку: у git не потрапляє навіть шифротекст. У стані Pulumi він секрет.
const dbPassword = process.env.RDS_MASTER_PASSWORD;
if (!dbPassword) {
  throw new Error("RDS_MASTER_PASSWORD: expected string. Запускай через `npm run up:demo`");
}

// Мережа — зі стеку base того самого власника в Pulumi Cloud.
const base = new pulumi.StackReference(`${pulumi.getOrganization()}/hw31-base/base`);
const asString = (v: unknown): string => String(v);
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const publicSubnetIds = base.requireOutput("publicSubnetIds").apply(asStrings);
const privateSubnetIds = base.requireOutput("privateSubnetIds").apply(asStrings);
const albSgId = base.requireOutput("albSgId").apply(asString);
const dbSgId = base.requireOutput("dbSgId").apply(asString);

// ── RDS: Multi-AZ instance deployment ────────────────────────────────────────
// Саме instance (один інстанс + синхронний standby в іншій AZ), а не Multi-AZ DB cluster:
// той вимагає db.c6gd/m5d/m6gd і коштує від $0,2385/год — у 6,4 раза дорожче.
const dbSubnets = new aws.rds.SubnetGroup("hw31-db-subnets", {
  subnetIds: privateSubnetIds, // лише приватні: маршруту в інтернет у них немає
  description: "Private subnets of stack base, two AZs",
});

const db = new aws.rds.Instance("hw31-db", {
  engine: "postgres",
  engineVersion: "16",
  instanceClass: "db.t4g.micro", // $0,037/год у Multi-AZ; Free plan пускає лише t3/t4g.micro
  allocatedStorage: 20,
  storageType: "gp3",
  storageEncrypted: true, // ключ aws/rds, яким керує AWS: свій CMK — це $1/міс, що переживає destroy
  multiAz: true, // standby у другій AZ; читати з нього не можна — це не репліка
  dbSubnetGroupName: dbSubnets.name,
  vpcSecurityGroupIds: [dbSgId],
  publiclyAccessible: false,
  dbName: "marketplace",
  username: "marketplace",
  password: pulumi.secret(dbPassword),
  backupRetentionPeriod: 1, // мінімум, з яким працюють автоматичні бекапи
  deleteAutomatedBackups: true,
  performanceInsightsEnabled: false, // не оцінюється і коштує
  monitoringInterval: 0, // Enhanced Monitoring вимкнено з тієї ж причини
  applyImmediately: true,
  deletionProtection: false, // дубль трансформації: видно в коді, не лише в рантаймі
  skipFinalSnapshot: true,
});

// ── Ціль ALB: Lambda ─────────────────────────────────────────────────────────
// Lambda, а не EC2: без власної Public IPv4 і без погодинного рядка. /health віддає 503,
// коли HEALTHY=false — так demo:alb показує, як health check виводить ціль із ротації
// (той самий механізм, що readiness-проба на #28).
const HANDLER = `
exports.handler = async (event) => {
  const sick = process.env.HEALTHY === "false";
  const code = event.path === "/health" && sick ? 503 : 200;
  return {
    statusCode: code,
    statusDescription: code === 200 ? "200 OK" : "503 Service Unavailable",
    isBase64Encoded: false,
    headers: { "content-type": "text/plain" },
    body: code === 200 ? "ok\\n" : "draining\\n",
  };
};`;

// Роль без жодної політики: функції не потрібен доступ до AWS. Навіть права на логи
// не даємо — інакше Lambda створила б log group поза стеком, і destroy її б не прибрав.
const targetRole = new aws.iam.Role("hw31-target-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
  }),
});

const fn = new aws.lambda.Function("hw31-target", {
  runtime: "nodejs22.x",
  handler: "index.handler",
  role: targetRole.arn,
  code: new pulumi.asset.AssetArchive({ "index.js": new pulumi.asset.StringAsset(HANDLER) }),
  environment: { variables: { HEALTHY: "true" } },
  memorySize: 128,
  timeout: 5,
});

// ── ALB: internet-facing у двох публічних підмережах ─────────────────────────
// Під ним AWS тримає по Public IPv4 на кожну AZ: 2 × $0,005/год, яких немає на схемі.
const alb = new aws.lb.LoadBalancer("hw31-alb", {
  loadBalancerType: "application",
  internal: false,
  ipAddressType: "ipv4",
  subnets: publicSubnetIds,
  securityGroups: [albSgId],
  enableDeletionProtection: false,
});

const tg = new aws.lb.TargetGroup("hw31-tg", {
  targetType: "lambda",
  healthCheck: {
    enabled: true,
    path: "/health",
    matcher: "200",
    interval: 35, // для Lambda-цілей timeout ≤ interval; 35/30 — значення AWS за замовчуванням
    timeout: 30,
    healthyThreshold: 2,
    unhealthyThreshold: 2,
  },
});

// Дозвіл elasticloadbalancing викликати саме цю функцію і саме з цієї target group.
const invoke = new aws.lambda.Permission("hw31-alb-invoke", {
  action: "lambda:InvokeFunction",
  function: fn.name,
  principal: "elasticloadbalancing.amazonaws.com",
  sourceArn: tg.arn,
});

new aws.lb.TargetGroupAttachment("hw31-tg-target", {
  targetGroupArn: tg.arn,
  targetId: fn.arn,
}, { dependsOn: [invoke] });

new aws.lb.Listener("hw31-http", {
  loadBalancerArn: alb.arn,
  port: 80,
  protocol: "HTTP",
  defaultActions: [{ type: "forward", targetGroupArn: tg.arn }],
});

// ── NAT: лише за прапорцем hw31:withNat ──────────────────────────────────────
// Маршруту з приватних підмереж на нього немає і не буде: вимір — ціна, не маршрутизація.
// Партіальна година NAT білиться як повна: 5 хвилин життя = $0,052 + $0,005 за його IPv4.
let natGatewayId: pulumi.Output<string> | undefined;
if (withNat) {
  const natEip = new aws.ec2.Eip("hw31-nat-eip", { domain: "vpc" });
  const nat = new aws.ec2.NatGateway("hw31-nat", {
    allocationId: natEip.id,
    subnetId: publicSubnetIds.apply((ids) => ids[0]),
    connectivityType: "public",
  });
  natGatewayId = nat.id;
}

export const dbIdentifier = db.identifier;
export const dbAddress = db.address;
export const dbAz = db.availabilityZone;
export const albDns = alb.dnsName;
export const albArn = alb.arn;
export const targetGroupArn = tg.arn;
export const targetFunction = fn.name;
export const natId = natGatewayId;
