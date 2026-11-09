#!/usr/bin/env bash
# demo:rollout (#28) — rolling update під навантаженням: чи лишився хоч один
# запит без відповіді.
#
#   npm run demo:rollout                 # профіль good: очікуємо failed=0
#   PROFILE=bad npm run demo:rollout     # без проб і дренажу — для порівняння;
#                                        # наприкінці кластер повертається в good
#
# Як міряємо:
#   1. генератор (scripts/load.mjs) б'є в GET /v1/products через NodePort з
#      темпом LOAD_RPS (200/с) і пише код КОЖНОЇ відповіді в файл, 000 — відповіді
#      не було (з причиною й моментом);
#   2. нова ревізія pod-шаблону — `rev` у конфігу стеку + `pulumi up`;
#   3. rollout-seconds — від того, як Deployment отримав нову generation, до
#      кінця `kubectl rollout status`;
#   4. навантаження триває, доки не зникнуть старі поди (дренаж), і щонайменше
#      LOAD_MIN_SECONDS — щоб вимір не був порожнім;
#   5. requests / ok / failed рахуються з файла. failed — усе, що не 200.
# Скрипт завершується з кодом 0, лише якщо failed=0 і requests ≥ 5000.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

CTX="${KUBE_CONTEXT:-kind-marketplace}"
NS="${K8S_NAMESPACE:-marketplace}"
DEP=marketplace-api
PROFILE="${PROFILE:-good}"
URL="${LOAD_URL:-http://127.0.0.1:22880/v1/products?limit=1}"
RPS="${LOAD_RPS:-200}"
MIN_SECONDS="${LOAD_MIN_SECONDS:-45}"
MIN_REQUESTS=5000

kc() { kubectl --context "${CTX}" -n "${NS}" "$@"; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/demo-rollout.XXXXXX")"
OUT="${WORK}/codes.txt"
LOAD_PID=""

cleanup() {
  if [ -n "${LOAD_PID}" ]; then touch "${OUT}.stop"; wait "${LOAD_PID}" 2>/dev/null || true; fi
  # Демо лишає кластер у коректному профілі: інакше наступний прогін міряв би
  # наслідки цього.
  if [ "${PROFILE}" != "good" ]; then
    echo "→ повертаю профіль good" >&2
    bash scripts/infra.sh config profile good >/dev/null
    bash scripts/infra.sh up >"${WORK}/restore.log" 2>&1 || tail -20 "${WORK}/restore.log" >&2
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

up_quiet() {
  if ! bash scripts/infra.sh up >"${WORK}/up.log" 2>&1; then
    tail -30 "${WORK}/up.log" >&2
    return 1
  fi
}

# Скільки подів API ще живе, включно з тими, що дренажать після SIGTERM.
pod_count() { kc get pods -l "app=${DEP}" --no-headers 2>/dev/null | wc -l | tr -d ' '; }

echo "→ базовий стан: профіль ${PROFILE}" >&2
bash scripts/infra.sh config profile "${PROFILE}" >/dev/null
up_quiet
kc rollout status "deploy/${DEP}" --timeout=300s >/dev/null
REPLICAS="$(kc get deploy "${DEP}" -o jsonpath='{.spec.replicas}')"

# Перший 200 до старту виміру: інакше міряли б прогрів, а не rollout.
curl -sf -o /dev/null --retry 60 --retry-all-errors --retry-delay 1 --max-time 3 "${URL}" \
  || { echo "demo:rollout: ${URL} не відповідає 200" >&2; exit 1; }

echo "→ навантаження: ${RPS} запитів/с на ${URL}" >&2
node scripts/load.mjs "${URL}" "${OUT}" "${RPS}" 900 &
LOAD_PID=$!
LOAD_START="$(now_ms)"
sleep 3

GEN0="$(kc get deploy "${DEP}" -o jsonpath='{.metadata.generation}')"
REV="r$(date +%s)"
echo "→ нова ревізія ${REV}: pulumi up" >&2
bash scripts/infra.sh config rev "${REV}" >/dev/null
bash scripts/infra.sh up >"${WORK}/up.log" 2>&1 &
PULUMI_PID=$!

# Початок rollout — момент, коли Deployment отримав новий шаблон.
while [ "$(kc get deploy "${DEP}" -o jsonpath='{.metadata.generation}')" = "${GEN0}" ]; do
  kill -0 "${PULUMI_PID}" 2>/dev/null || { wait "${PULUMI_PID}" || true; tail -30 "${WORK}/up.log" >&2; exit 1; }
  sleep 0.2
done
T0="$(now_ms)"
kc rollout status "deploy/${DEP}" --timeout=300s >/dev/null
T1="$(now_ms)"
wait "${PULUMI_PID}" || { tail -30 "${WORK}/up.log" >&2; exit 1; }

# Старі поди ще дренажать після SIGTERM — навантаження йде і на цей відрізок.
for _ in $(seq 1 60); do [ "$(pod_count)" -le "${REPLICAS}" ] && break; sleep 0.5; done
sleep 2
ELAPSED_MS=$(( $(now_ms) - LOAD_START ))
if [ "${ELAPSED_MS}" -lt $(( MIN_SECONDS * 1000 )) ]; then
  sleep $(( (MIN_SECONDS * 1000 - ELAPSED_MS) / 1000 + 1 ))
fi
touch "${OUT}.stop"
wait "${LOAD_PID}"
LOAD_PID=""

# ── Усе нижче — з файла кодів, і лише з нього ───────────────────────────────
REQUESTS="$(wc -l < "${OUT}" | tr -d ' ')"
OK="$(grep -cx '200' "${OUT}" || true)"
FAILED=$(( REQUESTS - OK ))
NO_RESPONSE="$(grep -c '^000' "${OUT}" || true)"

echo "profile=${PROFILE}"
echo "requests=${REQUESTS}"
echo "ok=${OK}"
echo "failed=${FAILED}"
echo "no-response=${NO_RESPONSE}"
echo "rollout-seconds=$(awk -v ms=$(( T1 - T0 )) 'BEGIN { printf "%.1f", ms / 1000 }')"
echo "load-seconds=$(awk -v ms=$(( $(now_ms) - LOAD_START )) 'BEGIN { printf "%.1f", ms / 1000 }')"
# Кожен збій без відповіді — причина і момент відносно початку rollout (T0).
# awk, а не grep: grep без збігів повертає 1, і з pipefail скрипт вийшов би
# раніше за фінальну перевірку саме тоді, коли збоїв немає.
awk '/^000 / { n[$2]++ } END { for (r in n) printf "# no-response %s: %d\n", r, n[r] }' "${OUT}"
awk -v t0="${T0}" '/^000 / && n++ < 10 { printf "# no-response %s at %+.1fs\n", $2, ($3 - t0) / 1000 }' "${OUT}"

[ "${FAILED}" -eq 0 ] && [ "${REQUESTS}" -ge "${MIN_REQUESTS}" ]
