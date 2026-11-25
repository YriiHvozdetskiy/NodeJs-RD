#!/usr/bin/env bash
# Шість перевірок порожнечі після `pulumi destroy` стеку demo (#31).
# Запускають обидва шляхи знесення: .github/workflows/teardown.yml і `npm run destroy:demo`.
#
# Кожен ключ друкується рівно один раз: критерій G2 бере останнє входження в лозі CI.
# Два джерела правди навмисно: стан Pulumi бачить лише те, що Pulumi створив, а запити
# до AWS бачать і те, що створено руками чи пережило destroy. Розходження між ними і є хвіст.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# У CI pulumi й aws стоять у системі; на ноутбуці — контейнери з scripts/bin/.
source "${ROOT}/scripts/lib/tools.sh"
PULUMI="$(tool_path pulumi)"
AWS="$(tool_path aws)"

# Регіон — з конфігу стеку, а не з ~/.aws/config: стек не в тому регіоні дав би чесні нулі.
R="$(sed -nE 's/^  aws:region: *([a-z0-9-]+).*/\1/p' "${ROOT}/infra/demo/Pulumi.demo.yaml")"
echo "region=${R}"

# 1. Стан Pulumi: ресурси aws:* стеку demo. `[]?` — після destroy масиву resources може не бути.
state="$("${PULUMI}" stack export --stack demo --cwd "${ROOT}/infra/demo" --non-interactive \
  | jq '[.deployment.resources[]? | select(.type | startswith("aws:"))] | length')"

# 2. Тег-API, свій регіон + us-east-1 (глобальні сервіси пишуть туди).
# Фільтр Stack=demo: стек base лишається стояти (у ньому ця сама роль CI), і його
# VPC з підмережами завжди дали б ненуль. Знесений NAT AWS ще до години показує в
# тег-API; живі NAT рахує nat-left за станом, тож тут NAT-и не рахуємо.
tagged() {
  "${AWS}" resourcegroupstaggingapi get-resources --region "$1" \
    --tag-filters Key=Project,Values=nodejs-pro-hw31 Key=Stack,Values=demo \
    --query "length(ResourceTagMappingList[?!contains(ResourceARN, ':natgateway/')])" --output text
}
tagged_r="$(tagged "${R}")"
tagged_us="$(tagged us-east-1)"

# 3–6. Те, що білиться погодинно, — по всьому регіону, а не лише за тегом.
rds="$("${AWS}" rds describe-db-instances --region "${R}" --query 'length(DBInstances)' --output text)"
alb="$("${AWS}" elbv2 describe-load-balancers --region "${R}" --query 'length(LoadBalancers)' --output text)"
nat="$("${AWS}" ec2 describe-nat-gateways --region "${R}" --filter Name=state,Values=available,pending \
  --query 'length(NatGateways)' --output text)"
# Elastic IP без прив'язки білиться ті самі $0,005/год, що й робоча адреса.
eip="$("${AWS}" ec2 describe-addresses --region "${R}" --query 'length(Addresses)' --output text)"

echo "tagged-resources-${R}=${tagged_r}"
echo "tagged-resources-us-east-1=${tagged_us}"
echo "state-resources-left=${state}"
echo "tagged-resources-left=$(( tagged_r + tagged_us ))"
echo "rds-left=${rds}"
echo "alb-left=${alb}"
echo "nat-left=${nat}"
echo "eip-left=${eip}"

total=$(( state + tagged_r + tagged_us + rds + alb + nat + eip ))
if [ "${total}" -ne 0 ]; then
  echo "НЕ ПОРОЖНЬО: щось пережило destroy — дивись рядки вище" >&2
  exit 1
fi
echo "empty=yes"
