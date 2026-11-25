#!/usr/bin/env bash
# Стеки ДЗ #31 у справжньому AWS: infra/base (усе за $0) і infra/demo (погодинне).
#
#   bash scripts/aws.sh up base|demo       pulumi up; після base — evidence base + iam
#   bash scripts/aws.sh destroy base|demo  pulumi destroy; після demo — шість перевірок порожнечі
#   bash scripts/aws.sh preview base|demo  pulumi preview: типізує й дифить, нічого не створює
#   bash scripts/aws.sh init demo          порожній стек demo — для репетиції teardown без витрат
#   bash scripts/aws.sh evidence base|iam  evidence/base.txt + base-state.json | iam.json + iam.txt
#
# Запускається лише через обгортку сховища (npm run up:base тощо):
#   bash scripts/with-secrets.sh aws bash scripts/aws.sh up base
# Стан — Pulumi Cloud (PULUMI_ACCESS_TOKEN), бо teardown у GitHub Actions мусить його бачити.
# `pulumi login` ніде не викликається: він переписав би глобальний стан машини.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-}"; STACK="${2:-}"

# pulumi і aws із системи, а якщо їх немає — з контейнерів (scripts/lib/tools.sh, scripts/bin/aws).
source "${ROOT}/scripts/lib/tools.sh"
PULUMI="$(tool_path pulumi)"
AWS="$(tool_path aws)"
export PULUMI_SKIP_UPDATE_CHECK=true

usage() { echo "aws.sh: up|destroy|preview base|demo · init demo · evidence base|iam" >&2; exit 2; }
[ -n "${PULUMI_ACCESS_TOKEN:-}" ] || { echo "aws.sh: запускай через scripts/with-secrets.sh aws" >&2; exit 1; }

region_of() { sed -nE 's/^  aws:region: *([a-z0-9-]+).*/\1/p' "${ROOT}/infra/$1/Pulumi.$1.yaml"; }
p() { local s="$1"; shift; "${PULUMI}" "$@" --stack "${s}" --cwd "${ROOT}/infra/${s}" --non-interactive; }

prepare() {
  local s="$1"
  [ -d "${ROOT}/infra/${s}/node_modules" ] || (cd "${ROOT}/infra/${s}" && npm ci --no-audit --no-fund)
  # Свіжий акаунт Pulumi Cloud стеку ще не має: --create робить <user>/hw31-<s>/<s>.
  "${PULUMI}" stack select --create "${s}" --cwd "${ROOT}/infra/${s}" --non-interactive >/dev/null
}

# Скільки ресурсів aws:* лишилось у стані стеку.
state_left() {
  p "$1" stack export | jq '[.deployment.resources[]? | select(.type | startswith("aws:"))] | length'
}

rds_password() {
  local f="${ROOT}/secrets/rds_master_password"
  if [ ! -s "${f}" ]; then
    # hex: RDS не приймає в паролі / " @ і пробіл, а hex їх не містить. 48 символів ≤ 128.
    (umask 077 && openssl rand -hex 24 > "${f}")
    echo "→ створено secrets/rds_master_password" >&2
  fi
  RDS_MASTER_PASSWORD="$(cat "${f}")"
  export RDS_MASTER_PASSWORD
}

evidence_base() {
  local R VPC PUB PRIV subnets rts
  R="$(region_of base)"
  mkdir -p "${ROOT}/evidence"
  # Стан як є, без правок. Секрети (адреса бюджету) у ньому лишаються шифротекстом.
  p base stack export > "${ROOT}/evidence/base-state.json"

  VPC="$(p base stack output vpcId)"
  PUB="$(p base stack output publicSubnetIds --json)"
  PRIV="$(p base stack output privateSubnetIds --json)"
  subnets="$("${AWS}" ec2 describe-subnets --region "${R}" --filters "Name=vpc-id,Values=${VPC}" --output json)"
  rts="$("${AWS}" ec2 describe-route-tables --region "${R}" --filters "Name=vpc-id,Values=${VPC}" --output json)"

  # Публічність і приватність рахуються з таблиць маршрутів AWS, а не з назв і тегів.
  # Підмережа без явної прив'язки живе на main route table VPC — це теж враховано.
  local counts
  counts="$(jq -rn --argjson pub "${PUB}" --argjson priv "${PRIV}" \
      --argjson s "${subnets}" --argjson t "${rts}" '
    def rt_of($id):
      ([$t.RouteTables[] | select(any(.Associations[]?; .SubnetId == $id))] | first)
      // ([$t.RouteTables[] | select(any(.Associations[]?; .Main == true))] | first);
    def default_routes($rt): [$rt.Routes[]? | select(.DestinationCidrBlock == "0.0.0.0/0")];
    def to_igw($rt): any(default_routes($rt)[]; (.GatewayId // "") | startswith("igw-"));
    ($s.Subnets | map(.SubnetId)) as $real
    | {
        "public-subnets": ([$pub[] | select(. as $id | $real | index($id)) | select(to_igw(rt_of(.)))] | length),
        "private-subnets": ([$priv[] | select(. as $id | $real | index($id))] | length),
        "subnet-azs": ([$s.Subnets[].AvailabilityZone] | unique | length),
        "private-default-route": ([$priv[] | rt_of(.)] | unique_by(.RouteTableId)
                                  | map(default_routes(.) | length) | add // 0)
      }
    | to_entries[] | "\(.key)=\(.value)"')"

  local sgs tagged_r tagged_us
  sgs="$("${AWS}" ec2 describe-security-groups --region "${R}" --filters "Name=vpc-id,Values=${VPC}" \
          --query "length(SecurityGroups[?GroupName!='default'])" --output text)"
  tagged_r="$("${AWS}" resourcegroupstaggingapi get-resources --region "${R}" \
          --tag-filters Key=Project,Values=nodejs-pro-hw31 Key=Stack,Values=base \
          --query 'length(ResourceTagMappingList)' --output text)"
  tagged_us="$("${AWS}" resourcegroupstaggingapi get-resources --region us-east-1 \
          --tag-filters Key=Project,Values=nodejs-pro-hw31 Key=Stack,Values=base \
          --query 'length(ResourceTagMappingList)' --output text)"

  {
    echo "region=${R}"
    echo "vpc-id=${VPC}"
    echo "${counts}"
    echo "security-groups=${sgs}"
    echo "tagged-resources=$(( tagged_r + tagged_us ))"
    echo "tagged-resources-${R}=${tagged_r}"
    echo "tagged-resources-us-east-1=${tagged_us}"
    echo "hourly-resources=$(jq '[.deployment.resources[]?.type
      | select(test("aws:rds/|aws:lb/|aws:ec2/natGateway|aws:ec2/instance:|aws:ec2/eip:|aws:elasticache/"))]
      | length' "${ROOT}/evidence/base-state.json")"
  } > "${ROOT}/evidence/base.txt"
  cat "${ROOT}/evidence/base.txt"
}

evidence_iam() {
  local R ROLE_ARN ROLE ACCT tmp
  R="$(region_of base)"
  ROLE_ARN="$(p base stack output ciRoleArn)"
  ROLE="${ROLE_ARN##*/}"
  ACCT="$(cut -d: -f5 <<< "${ROLE_ARN}")"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/hw31-iam.XXXXXX")"
  trap 'rm -rf "${tmp}"' RETURN

  # CLI v2 віддає обидва документи вже розкодованими JSON-об'єктами, а не URL-encoded рядком.
  "${AWS}" iam get-role --role-name "${ROLE}" --output json > "${tmp}/role.json"
  "${AWS}" iam get-role-policy --role-name "${ROLE}" --policy-name teardown-demo --output json > "${tmp}/policy.json"
  jq -n --slurpfile r "${tmp}/role.json" --slurpfile p "${tmp}/policy.json" '{
      roleArn: $r[0].Role.Arn,
      trustPolicy: $r[0].Role.AssumeRolePolicyDocument,
      permissionPolicy: { name: $p[0].PolicyName, document: $p[0].PolicyDocument },
      role: $r[0].Role
    }' > "${ROOT}/evidence/iam.json"

  # Рішення ухвалює рушій AWS, а не наш код: simulate-principal-policy на справжній ролі.
  sim() {
    local action="$1" resource="${2:-}"
    if [ -n "${resource}" ]; then
      "${AWS}" iam simulate-principal-policy --policy-source-arn "${ROLE_ARN}" \
        --action-names "${action}" --resource-arns "${resource}" --output json
    else
      "${AWS}" iam simulate-principal-policy --policy-source-arn "${ROLE_ARN}" \
        --action-names "${action}" --output json
    fi
  }
  # Ім'я — у тій формі, яку Pulumi справді дає RDS-інстансу: суфікс без дефіса.
  local own_db="arn:aws:rds:${R}:${ACCT}:db:hw31-db0000000"
  local foreign_db="arn:aws:rds:${R}:${ACCT}:db:marketplace-prod"
  sim rds:DeleteDBInstance "${own_db}"     > "${tmp}/allowed.json"
  sim rds:CreateDBInstance                 > "${tmp}/denied.json"
  sim rds:DeleteDBInstance "${foreign_db}" > "${tmp}/foreign.json"
  jq -n --slurpfile a "${tmp}/allowed.json" --slurpfile d "${tmp}/denied.json" \
        --slurpfile f "${tmp}/foreign.json" \
    '{allowed: $a[0].EvaluationResults, denied: $d[0].EvaluationResults, foreignDb: $f[0].EvaluationResults}' \
    > "${ROOT}/evidence/iam-simulate.json"

  local decision='.EvaluationResults[0].EvalDecision'
  {
    echo "role-arn=${ROLE_ARN}"
    echo "sim-allowed-action=rds:DeleteDBInstance on db:hw31-db0000000"
    echo "sim-allowed=$(jq -r "${decision}" "${tmp}/allowed.json")"
    echo "sim-denied-action=rds:CreateDBInstance"
    echo "sim-denied=$(jq -r "${decision}" "${tmp}/denied.json")"
    echo "sim-denied-foreign-db=$(jq -r "${decision}" "${tmp}/foreign.json")"
  } > "${ROOT}/evidence/iam.txt"
  cat "${ROOT}/evidence/iam.txt"
}

case "${ACTION}:${STACK}" in
  up:base)
    prepare base
    p base up --yes --skip-preview
    evidence_base
    evidence_iam
    ;;
  up:demo)
    rds_password
    prepare demo
    p demo up --yes --skip-preview
    p demo stack output
    ;;
  preview:base) prepare base; p base preview ;;
  preview:demo) rds_password; prepare demo; p demo preview ;;
  init:demo) prepare demo; echo "stack demo: $(state_left demo) ресурсів aws:*" ;;
  destroy:demo)
    prepare demo
    p demo destroy --yes --skip-preview
    bash "${ROOT}/scripts/aws-empty.sh"
    ;;
  destroy:base)
    # base тримає мережу, у якій живе demo: зносити його першим — destroy застрягне на
    # «DependencyViolation» посеред дороги. Тож спершу перевіряємо, що demo порожній.
    prepare demo
    left="$(state_left demo)"
    [ "${left}" = 0 ] || { echo "aws.sh: у стеку demo ще ${left} ресурсів — спершу npm run destroy:demo" >&2; exit 1; }
    prepare base
    p base destroy --yes --skip-preview
    echo "state-resources-left-base=$(state_left base)"
    ;;
  evidence:base) prepare base; evidence_base ;;
  evidence:iam)  prepare base; evidence_iam ;;
  *) usage ;;
esac
