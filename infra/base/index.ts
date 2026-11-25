// Стек base (ДЗ #31): усе, що коштує $0 і може стояти тиждень.
//
// Тут немає жодного ресурсу з погодинною ставкою: RDS, ALB, NAT, EC2 і Elastic IP
// живуть лише в infra/demo. Бюджет реєструється першим, а кожен наступний ресурс
// чекає на нього через dependsOn — запобіжник стоїть раніше, ніж з'являється що втрачати.
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const cfg = new pulumi.Config("hw31");
// AZ — з конфігу, а не з getAvailabilityZones: preview тоді не питає хмару, які зони є.
const [azA, azB] = cfg.requireObject<[string, string]>("azs");
// owner/name репозиторію, з якого GitHub Actions запускає teardown.
const githubRepo = cfg.require("githubRepo");
// Адреса для листа бюджету — зі сховища #11 (secrets/budget_email через scripts/with-secrets.sh),
// а не з конфігу стеку: у git не потрапляє навіть шифротекст. destroy програму не виконує,
// тож teardown у CI цієї змінної не потребує.
const budgetEmail = process.env.BUDGET_EMAIL;
if (!budgetEmail) {
  throw new Error("BUDGET_EMAIL: expected string. Запускай через `npm run up:base`");
}

// ── 1. Бюджет ────────────────────────────────────────────────────────────────
// Бюджет — лист, а не гальмо: фактичні витрати Budgets перераховує раз на 8–12 годин.
// Тип ACTUAL, бо прогнозному на новому акаунті потрібно ~5 тижнів історії, і до того він мовчить.
// Бюджет на весь акаунт, без фільтра по тегу: тег як cost-allocation key вмикається з лагом (#30).
const budget = new aws.budgets.Budget("hw31-budget", {
  budgetType: "COST",
  timeUnit: "MONTHLY",
  limitAmount: "5", // $5 на місяць
  limitUnit: "USD",
  notifications: [{
    notificationType: "ACTUAL",
    comparisonOperator: "GREATER_THAN",
    threshold: 20, // 20 % від $5 = $1 фактичних витрат
    thresholdType: "PERCENTAGE",
    // Секрет: у `pulumi stack export` адреса лишається шифротекстом,
    // тому в публічному evidence/base-state.json її не видно.
    subscriberEmailAddresses: [pulumi.secret(budgetEmail)],
  }],
});
const afterBudget: pulumi.CustomResourceOptions = { dependsOn: [budget] };

// ── 2. VPC і чотири підмережі у двох AZ ──────────────────────────────────────
// 10.31.0.0/16 не перетинається з дефолтною VPC (172.31.0.0/16), мережами Docker
// (172.17+.0.0/16) і домашніми 192.168.x.x — VPN чи peering потім не впреться в дубль.
const VPC_CIDR = "10.31.0.0/16";
const vpc = new aws.ec2.Vpc("hw31-vpc", {
  cidrBlock: VPC_CIDR,
  enableDnsSupport: true,
  enableDnsHostnames: true, // RDS видає endpoint за DNS-іменем — без цього ім'я не резолвиться у VPC
}, afterBudget);

const publicSubnets = [azA, azB].map((az, i) => new aws.ec2.Subnet(`hw31-public-${i}`, {
  vpcId: vpc.id,
  availabilityZone: az,
  cidrBlock: `10.31.${i}.0/24`,
  // Публічна IPv4 коштує $0,005/год навіть у простої — роздаємо лише свідомо, не автоматично.
  mapPublicIpOnLaunch: false,
  tags: { Tier: "public" },
}, afterBudget));

const privateSubnets = [azA, azB].map((az, i) => new aws.ec2.Subnet(`hw31-private-${i}`, {
  vpcId: vpc.id,
  availabilityZone: az,
  cidrBlock: `10.31.${10 + i}.0/24`,
  tags: { Tier: "private" },
}, afterBudget));

// ── 3. Інтернет і маршрути ───────────────────────────────────────────────────
// IGW сам нічого не коштує: платять за трафік і за публічні адреси, а не за шлюз.
const igw = new aws.ec2.InternetGateway("hw31-igw", { vpcId: vpc.id }, afterBudget);

const publicRt = new aws.ec2.RouteTable("hw31-rt-public", {
  vpcId: vpc.id,
  routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }],
  tags: { Tier: "public" },
}, afterBudget);

// «Приватна» — це відсутність рядка 0.0.0.0/0, а не назва. У таблиці лишається тільки
// неявний маршрут local (10.31.0.0/16). NAT тут немає: у приватних підмережах живе лише
// база, і вихід в інтернет їй не потрібен — а NAT коштував би $0,052/год.
const privateRt = new aws.ec2.RouteTable("hw31-rt-private", {
  vpcId: vpc.id,
  routes: [],
  tags: { Tier: "private" },
}, afterBudget);

publicSubnets.forEach((s, i) => new aws.ec2.RouteTableAssociation(`hw31-rta-public-${i}`, {
  subnetId: s.id, routeTableId: publicRt.id,
}, afterBudget));
// Явна прив'язка: без неї приватна підмережа взяла б main route table VPC.
privateSubnets.forEach((s, i) => new aws.ec2.RouteTableAssociation(`hw31-rta-private-${i}`, {
  subnetId: s.id, routeTableId: privateRt.id,
}, afterBudget));

// ── 4. Security groups: alb → app → db ───────────────────────────────────────
// Ланцюжок курсового: балансувальник → застосунок Nest на :3000 → Postgres на :5432.
// Правила — окремими ресурсами, бо SG посилаються одна на одну, а вбудовані правила
// дали б цикл. Нова SG без правил egress не має нічого: дефолтний «allow all out»
// провайдер прибирає, тож кожен вихід нижче відкритий явно.
const albSg = new aws.ec2.SecurityGroup("hw31-sg-alb", {
  vpcId: vpc.id, description: "ALB: HTTP from the internet, forwards to app",
}, afterBudget);
const appSg = new aws.ec2.SecurityGroup("hw31-sg-app", {
  vpcId: vpc.id, description: "App targets: from ALB only, to Postgres only",
}, afterBudget);
const dbSg = new aws.ec2.SecurityGroup("hw31-sg-db", {
  vpcId: vpc.id, description: "RDS Postgres: from app only",
}, afterBudget);

// 80/tcp з усього інтернету — публічний вхід балансувальника. 443 не відкриваємо:
// домену і сертифіката в ДЗ немає (hosted zone у Route 53 білиться за повний місяць).
new aws.vpc.SecurityGroupIngressRule("hw31-alb-in-http", {
  securityGroupId: albSg.id, ipProtocol: "tcp", fromPort: 80, toPort: 80,
  cidrIpv4: "0.0.0.0/0", description: "HTTP to ALB from the internet",
}, afterBudget);
// 3000/tcp до app SG — ALB пересилає запит на порт Nest. Lambda-ціль демо ALB викликає
// поза VPC, її SG не стосується; правило — для EC2/ECS-цілі (#33).
new aws.vpc.SecurityGroupEgressRule("hw31-alb-out-app", {
  securityGroupId: albSg.id, ipProtocol: "tcp", fromPort: 3000, toPort: 3000,
  referencedSecurityGroupId: appSg.id, description: "ALB to app on 3000",
}, afterBudget);
// 3000/tcp лише від ALB SG: застосунок не приймає нічого напряму з інтернету.
new aws.vpc.SecurityGroupIngressRule("hw31-app-in-alb", {
  securityGroupId: appSg.id, ipProtocol: "tcp", fromPort: 3000, toPort: 3000,
  referencedSecurityGroupId: albSg.id, description: "App on 3000 from ALB",
}, afterBudget);
// 5432/tcp до db SG — єдиний вихід застосунку, який потрібен цьому стеку.
new aws.vpc.SecurityGroupEgressRule("hw31-app-out-db", {
  securityGroupId: appSg.id, ipProtocol: "tcp", fromPort: 5432, toPort: 5432,
  referencedSecurityGroupId: dbSg.id, description: "App to Postgres",
}, afterBudget);
// 5432/tcp лише від app SG: база не бачить ні інтернету, ні решти VPC. Egress у db SG
// немає взагалі: SG stateful, відповідь на вхідне з'єднання проходить без окремого правила.
new aws.vpc.SecurityGroupIngressRule("hw31-db-in-app", {
  securityGroupId: dbSg.id, ipProtocol: "tcp", fromPort: 5432, toPort: 5432,
  referencedSecurityGroupId: appSg.id, description: "Postgres from app",
}, afterBudget);

// ── 5. OIDC-провайдер GitHub і роль teardown ─────────────────────────────────
// Ключів у конвеєрі немає: GitHub видає джобі короткий JWT, AWS звіряє його підпис
// із цим провайдером і віддає креденшели ролі на годину.
const githubOidc = new aws.iam.OpenIdConnectProvider("hw31-github-oidc", {
  url: "https://token.actions.githubusercontent.com",
  clientIdLists: ["sts.amazonaws.com"],
}, afterBudget);

const [owner, repoName] = githubRepo.split("/");
// sub звужено до репозиторію І до GitHub Environment `teardown`: токен із будь-якої
// іншої джоби цього ж репо (PR, ci.yml) роль не отримає. Другий шаблон — формат
// із незмінними id власника і репо, який GitHub видає новим репозиторіям.
const subjects = [
  `repo:${owner}/${repoName}:environment:teardown`,
  `repo:${owner}@*/${repoName}@*:environment:teardown`,
];

const ciRole = new aws.iam.Role("hw31-ci-teardown", {
  name: "hw31-ci-teardown", // стабільний ARN: він стоїть відкритим текстом у teardown.yml
  description: "GitHub Actions teardown.yml: destroys stack demo and checks it is empty",
  maxSessionDuration: 3600,
  assumeRolePolicy: githubOidc.arn.apply((providerArn) => JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: providerArn },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        // aud — кому GitHub адресував токен; без цієї умови підійшов би токен для чужого сервісу.
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        StringLike: { "token.actions.githubusercontent.com:sub": subjects },
      },
    }],
  })),
}, afterBudget);

const accountId = aws.getCallerIdentityOutput({}, { parent: ciRole }).accountId;

// Політика дозволів: лише знести стек demo і перевірити, що він порожній.
// Жодного "*" в Action. Видалення звужено ARN-ами з префіксами імен, які Pulumi дає
// ресурсам demo (hw31-alb-…, hw31-tg-…). Імена звірено з `pulumi preview --diff`: RDS-інстансу
// Pulumi дописує суфікс БЕЗ дефіса (hw31-db32ab45e), тому там шаблон hw31-db*, а не hw31-db-*.
// Resource "*" — тільки там, де в ARN немає
// імені (NAT, Elastic IP) і для Describe/GetResources, які рахують залишки.
// Пояснення кожного дозволу — README, ## AWS.
const teardownPolicy = accountId.apply((acct) => JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "RdsDelete",
      Effect: "Allow",
      Action: ["rds:DeleteDBInstance", "rds:DeleteDBSubnetGroup"],
      Resource: [
        `arn:aws:rds:*:${acct}:db:hw31-db*`,
        `arn:aws:rds:*:${acct}:subgrp:hw31-db-subnets-*`,
      ],
    },
    {
      Sid: "ElbDelete",
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:DeleteLoadBalancer",
        "elasticloadbalancing:DeleteListener",
        "elasticloadbalancing:DeleteTargetGroup",
        "elasticloadbalancing:DeregisterTargets",
      ],
      Resource: [
        `arn:aws:elasticloadbalancing:*:${acct}:loadbalancer/app/hw31-alb-*/*`,
        `arn:aws:elasticloadbalancing:*:${acct}:listener/app/hw31-alb-*/*`,
        `arn:aws:elasticloadbalancing:*:${acct}:targetgroup/hw31-tg-*/*`,
      ],
    },
    {
      Sid: "LambdaDelete",
      Effect: "Allow",
      Action: ["lambda:DeleteFunction", "lambda:GetFunction", "lambda:RemovePermission", "lambda:GetPolicy"],
      Resource: `arn:aws:lambda:*:${acct}:function:hw31-target-*`,
    },
    {
      Sid: "IamDeleteTargetRole",
      Effect: "Allow",
      Action: [
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListInstanceProfilesForRole",
      ],
      Resource: `arn:aws:iam::${acct}:role/hw31-target-role-*`,
    },
    {
      Sid: "Ec2DeleteNat",
      Effect: "Allow",
      Action: ["ec2:DeleteNatGateway", "ec2:ReleaseAddress", "ec2:DisassociateAddress"],
      Resource: "*",
    },
    {
      Sid: "ReadLeftovers",
      Effect: "Allow",
      Action: [
        "rds:DescribeDBInstances",
        "rds:DescribeDBSubnetGroups",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:DescribeTargetGroups",
        "elasticloadbalancing:DescribeTargetHealth",
        "ec2:DescribeNatGateways",
        "ec2:DescribeAddresses",
        "ec2:DescribeNetworkInterfaces",
        "tag:GetResources",
      ],
      Resource: "*",
    },
  ],
}));

new aws.iam.RolePolicy("hw31-ci-teardown", {
  role: ciRole.id,
  name: "teardown-demo",
  policy: teardownPolicy,
}, afterBudget);

// ── Виходи: їх читають infra/demo (StackReference), evidence і teardown.yml ──
export const vpcId = vpc.id;
export const publicSubnetIds = publicSubnets.map((s) => s.id);
export const privateSubnetIds = privateSubnets.map((s) => s.id);
export const publicRouteTableId = publicRt.id;
export const privateRouteTableId = privateRt.id;
export const albSgId = albSg.id;
export const appSgId = appSg.id;
export const dbSgId = dbSg.id;
export const githubOidcArn = githubOidc.arn;
export const ciRoleArn = ciRole.arn;
export const budgetName = budget.name;
