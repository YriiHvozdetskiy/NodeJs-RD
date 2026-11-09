#!/usr/bin/env bash
# demo:pdb (#28) — PDB лишає місце для обслуговування і зупиняє друге виселення.
#
# Виселення — через Eviction API, як це робить `kubectl drain`: POST на
# subresource pods/<pod>/eviction. Коди 201 / 429 — це HTTP-статуси відповіді
# API-сервера, які повертає curl через `kubectl proxy`, а не висновок скрипта.
#
# Звичайний `kubectl delete pod` PDB не зупиняє: бюджет діє лише на Eviction API.
#
# ⚠️ Демо витрачає бюджет: одразу після нього disruptionsAllowed = 0. Наприкінці
# скрипт чекає, поки Deployment відновить репліку, і бюджет повертається.
set -euo pipefail

CTX="${KUBE_CONTEXT:-kind-marketplace}"
NS="${K8S_NAMESPACE:-marketplace}"
DEP=marketplace-api
PDB=marketplace-api

kc() { kubectl --context "${CTX}" -n "${NS}" "$@"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/demo-pdb.XXXXXX")"
PROXY_PID=""
stop_proxy() {
  [ -n "${PROXY_PID}" ] || return 0
  kill "${PROXY_PID}" 2>/dev/null || true
  wait "${PROXY_PID}" 2>/dev/null || true
  PROXY_PID=""
}
cleanup() {
  stop_proxy
  rm -rf "${WORK}"
}
trap cleanup EXIT

kc rollout status "deploy/${DEP}" --timeout=300s >/dev/null

# Статус PDB оновлює контролер асинхронно — чекаємо, поки він порахує всі поди.
for _ in $(seq 1 30); do
  kc get pdb "${PDB}" -o json > "${WORK}/pdb.json"
  node -e 'const s = require(process.argv[1]).status ?? {}; process.exit(s.currentHealthy > 0 && s.currentHealthy === s.expectedPods ? 0 : 1)' "${WORK}/pdb.json" && break
  sleep 1
done
read -r HEALTHY DESIRED ALLOWED MAX_UNAVAILABLE < <(node -e '
  const p = require(process.argv[1]);
  console.log(p.status.currentHealthy, p.status.desiredHealthy, p.status.disruptionsAllowed, p.spec.maxUnavailable ?? "-");
' "${WORK}/pdb.json")

echo "healthy=${HEALTHY}"
# minAvailable тут — те, що порахував сам контролер PDB (status.desiredHealthy):
# у специфікації стоїть maxUnavailable: 1, і мінімум виводиться з поточного масштабу.
echo "minAvailable=${DESIRED}"
echo "maxUnavailable=${MAX_UNAVAILABLE}"
echo "disruptions-allowed=${ALLOWED}"

# Два готові поди, які не в процесі видалення.
kc get pods -l "app=${DEP}" -o json > "${WORK}/pods.json"
PODS="$(node -e '
  const ready = require(process.argv[1]).items.filter((p) => !p.metadata.deletionTimestamp
    && (p.status.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"));
  console.log(ready.slice(0, 2).map((p) => p.metadata.name).join(" "));
' "${WORK}/pods.json")"
read -r POD1 POD2 <<< "${PODS}"
[ -n "${POD2:-}" ] || { echo "demo:pdb: потрібні щонайменше два готові поди, є: ${PODS}" >&2; exit 1; }

kubectl --context "${CTX}" proxy --port=0 > "${WORK}/proxy.log" 2>&1 &
PROXY_PID=$!
PORT=""
for _ in $(seq 1 50); do
  PORT="$(sed -nE 's/.*127\.0\.0\.1:([0-9]+).*/\1/p' "${WORK}/proxy.log" | head -1)"
  [ -n "${PORT}" ] && break
  sleep 0.2
done
[ -n "${PORT}" ] || { echo "demo:pdb: kubectl proxy не стартував" >&2; cat "${WORK}/proxy.log" >&2; exit 1; }

evict() {
  curl -s -o "${WORK}/evict-$1.json" -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    --data "{\"apiVersion\":\"policy/v1\",\"kind\":\"Eviction\",\"metadata\":{\"name\":\"$2\",\"namespace\":\"${NS}\"}}" \
    "http://127.0.0.1:${PORT}/api/v1/namespaces/${NS}/pods/$2/eviction"
}

E1="$(evict 1 "${POD1}")"
E2="$(evict 2 "${POD2}")"
echo "evict-1=${E1}"
echo "evict-2=${E2}"
# Чому друге відхилене — текст відповіді API-сервера як є.
node -e 'try { console.log("# evict-2: " + require(process.argv[1]).message) } catch {}' "${WORK}/evict-2.json"

stop_proxy

# Відновлення: Deployment замінює виселений под, бюджет повертається до 1.
kc rollout status "deploy/${DEP}" --timeout=300s >/dev/null

[ "${E1}" = "201" ] && [ "${E2}" = "429" ]
