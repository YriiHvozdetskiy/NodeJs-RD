#!/usr/bin/env bash
# План бази PR (#32) — друга половина гейта вартості: «скільки коштувало ДО цього PR».
#
#   bash scripts/with-secrets.sh kind bash scripts/ci/base-plan.sh <sha-бази> <вихідний.json>
#
# Програма infra/ з коміту бази — окремим git worktree, тим самим
# scripts/infra.sh plan, в окремому стеку `base` того самого файлового бекенда.
# preview нічого не створює: кластер раннера той самий, стан стеку staging не
# зачіпається.
#
# Бази без infra/ (гілка до #28) — план без кроків, тобто $0: тоді вся
# вартість PR — це його зміна. Інша помилка preview — падіння, а не нуль:
# гейт, що вважає «не вдалося порахувати» за «безкоштовно», пропустив би все.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_SHA="${1:?sha бази}"; OUT="${2:?вихідний файл}"

TREE="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/base-tree.XXXXXX")"
cleanup() { git -C "${ROOT}" worktree remove --force "${TREE}" >/dev/null 2>&1 || rm -rf "${TREE}"; }
trap cleanup EXIT

git -C "${ROOT}" worktree add --detach "${TREE}" "${BASE_SHA}" >&2
if [ ! -f "${TREE}/infra/Pulumi.yaml" ]; then
  echo "base-plan: у ${BASE_SHA} немає infra/ — база коштує \$0" >&2
  printf '{"steps":[]}\n' > "${OUT}"
  exit 0
fi

# Скрипт голови, програма бази: однаковий спосіб рахувати, різний вхід.
INFRA_DIR="${TREE}/infra" PULUMI_STACK=base bash "${ROOT}/scripts/infra.sh" plan > "${OUT}"
echo "base-plan: ${BASE_SHA} → ${OUT}" >&2
