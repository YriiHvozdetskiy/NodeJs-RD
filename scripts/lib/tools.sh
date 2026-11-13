#!/usr/bin/env bash
# kind і pulumi без установки на машину (#28) — з контейнера marketplace-tools.
#
#   source scripts/lib/tools.sh
#   KIND="$(tool_path kind)"; "${KIND}" get clusters
#
# tool_path віддає системний бінарник, якщо він є, і лише інакше — обгортку з
# scripts/bin/. Грейдер зі своїми kind і pulumi контейнера не торкається.
#
# Що отримує контейнер і навіщо:
#   • сокет Docker — kind створює вузол кластера як СУСІДНІЙ контейнер у тому
#     самому Docker, kind load робить через нього ж docker save;
#   • репо за тим самим абсолютним шляхом — стан Pulumi лежить за
#     file://<репо>/.pulumi, і шлях усередині має збігатися з хостовим;
#   • тека kubeconfig — kind дописує туди контекст kind-marketplace, а kubectl
#     на машині читає його звідти ж;
#   • змінні сховища — ІМЕНАМИ (-e NAME): незадана на хості не з'являється в
#     контейнері, порожня приходить порожньою. На цій різниці стоїть критерій 5.
TOOLS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOLS_IMAGE="${TOOLS_IMAGE:-marketplace-tools:hw28}"
# Внутрішній kubeconfig: адреса API — https://marketplace-control-plane:6443 у
# Docker-мережі kind. 127.0.0.1 з хостового kubeconfig у контейнері — це сам контейнер.
TOOLS_INTERNAL_KUBECONFIG="${TOOLS_ROOT}/.kind/kubeconfig-internal"

tool_path() {
  local own="${TOOLS_ROOT}/scripts/bin/$1" found
  found="$(command -v "$1" 2>/dev/null || true)"
  if [ -n "${found}" ] && [ "${found}" != "${own}" ]; then echo "${found}"; else echo "${own}"; fi
}

tools_image() {
  docker image inspect "${TOOLS_IMAGE}" >/dev/null 2>&1 && return 0
  echo "→ збираю ${TOOLS_IMAGE} (docker/tools.Dockerfile), один раз" >&2
  docker build -q -f "${TOOLS_ROOT}/docker/tools.Dockerfile" -t "${TOOLS_IMAGE}" "${TOOLS_ROOT}/docker" >/dev/null
}

# Імена змінних, які читає infra/ — з самого infra/vault.ts, щоб список жив в одному місці.
tools_env_names() {
  grep -oE "'[A-Z][A-Z0-9_]+'" "${TOOLS_ROOT}/infra/vault.ts" | tr -d "'" | sort -u
  env | sed -nE 's/^((PULUMI|KIND)_[A-Za-z0-9_]*)=.*/\1/p'
}

# tools_run <kind|pulumi> [аргументи…]
tools_run() {
  local tool="$1"; shift
  tools_image
  local kubeconfig="${KUBECONFIG:-${HOME}/.kube/config}"
  mkdir -p "$(dirname "${kubeconfig}")"
  local args=(--rm -i
    -v /var/run/docker.sock:/var/run/docker.sock
    -v "${TOOLS_ROOT}:${TOOLS_ROOT}"
    -w "${PWD}")
  case "${PWD}/" in "${TOOLS_ROOT}/"*) ;; *) args+=(-v "${PWD}:${PWD}") ;; esac
  [ -t 0 ] && [ -t 1 ] && args+=(-t)

  if [ "${tool}" = "pulumi" ]; then
    # Плагін провайдера Kubernetes живе між запусками в томі. Вибраний стек — ні:
    # `pulumi stack select` пише його в PULUMI_HOME, а в системного pulumi
    # (ним `npm run up` користується, якщо він є) PULUMI_HOME свій — ~/.pulumi.
    # Тоді `pulumi preview` через scripts/bin у PATH падав «no stack selected».
    # PULUMI_STACK вибирає стек без збереженого стану, однаково для обох pulumi.
    args+=(-e PULUMI_HOME=/pulumi-home -v marketplace-pulumi-home:/pulumi-home
      -e "PULUMI_STACK=${PULUMI_STACK:-kind}")
    if [ -f "${TOOLS_INTERNAL_KUBECONFIG}" ] && docker network inspect kind >/dev/null 2>&1; then
      args+=(--network kind -e "KUBECONFIG=${TOOLS_INTERNAL_KUBECONFIG}")
    else
      args+=(-v "$(dirname "${kubeconfig}"):$(dirname "${kubeconfig}")" -e "KUBECONFIG=${kubeconfig}")
    fi
  else
    args+=(-v "$(dirname "${kubeconfig}"):$(dirname "${kubeconfig}")" -e "KUBECONFIG=${kubeconfig}")
  fi

  local name
  while IFS= read -r name; do
    [ -n "${name}" ] || continue
    # ${!name+x} — «змінна задана», навіть якщо порожня.
    if [ -n "${!name+x}" ]; then args+=(-e "${name}"); fi
  done < <(tools_env_names | sort -u)

  docker run "${args[@]}" "${TOOLS_IMAGE}" "${tool}" "$@"
}
