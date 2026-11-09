#!/usr/bin/env bash
# npm run cluster:down (#28) — зносить лише кластер курсового. Стан Pulumi в
# .pulumi/ лишається: після down спершу npm run destroy, якщо стек ще живий,
# або наступний npm run up створить усе заново на новому кластері.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/lib/tools.sh
"$(tool_path kind)" delete cluster --name "${KIND_CLUSTER:-marketplace}"
rm -rf .kind
