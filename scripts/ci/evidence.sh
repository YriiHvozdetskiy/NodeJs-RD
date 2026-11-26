#!/usr/bin/env bash
# Артефакт pipeline-evidence (#32): збирає частини, які вивантажили джоби прогону.
#
#   RUN_ID=… HEAD_SHA=… IMAGE_REF=… BUILT_DIGEST=… \
#     bash scripts/ci/evidence.sh <теки-частин> <вихідна-тека>
#
# Кожна джоба — окрема машина, тож частини приїжджають артефактами
# evidence-*: build.log (build), scan.txt (scan), oidc.txt / plan.json /
# cost.txt / deployment.json / secret-count.txt / rollout.txt (staging).
#
# Числа тут не друкуються, а ЧИТАЮТЬСЯ з частин: digest — з output джоби
# збірки і з маніфеста, що поїхав у кластер; build-invocations — `wc -l`
# build.log; rollout-* — рядки самого demo:rollout. Частини немає (джоба
# впала раніше) — ключ лишається порожнім, а не вигаданим. Скрипт не падає:
# артефакт потрібен саме на червоному прогоні.
set -uo pipefail
PARTS="${1:?теки частин}"; OUT="${2:?вихідна тека}"
mkdir -p "${OUT}"

# Перше значення ключа з файла частини; немає файла чи ключа — порожньо.
kv() { [ -f "${PARTS}/$1" ] && sed -n "s/^$2=//p" "${PARTS}/$1" | head -1; }

deployed=""
if [ -f "${PARTS}/deployment.json" ]; then
  # Образ контейнера API з маніфеста, який прийняв кластер: ref@sha256:… → sha256:…
  deployed="$(node -e '
    const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const image = d.spec.template.spec.containers.find((c) => c.name === "api")?.image ?? "";
    process.stdout.write(image.includes("@") ? image.split("@")[1] : "");
  ' "${PARTS}/deployment.json")"
fi

invocations=""
[ -f "${PARTS}/build.log" ] && invocations="$(wc -l < "${PARTS}/build.log" | tr -d ' ')"

creds=""
[ "$(kv oidc.txt sig-verified)" = "1" ] && creds="oidc"

{
  echo "run-id=${RUN_ID:-}"
  echo "head-sha=${HEAD_SHA:-}"
  echo "image-ref=${IMAGE_REF:-}"
  echo "built-digest=${BUILT_DIGEST:-}"
  echo "deployed-digest=${deployed}"
  echo "build-invocations=${invocations}"
  echo "creds-source=${creds}"
  echo "oidc-iss=$(kv oidc.txt oidc-iss)"
  echo "oidc-aud=$(kv oidc.txt oidc-aud)"
  echo "oidc-sub=$(kv oidc.txt oidc-sub)"
  echo "oidc-sig-verified=$(kv oidc.txt sig-verified)"
  echo "oidc-policy-allow=$(kv oidc.txt policy-allow)"
  echo "rollout-requests=$(kv rollout.txt requests)"
  echo "rollout-ok=$(kv rollout.txt ok)"
  echo "rollout-failed=$(kv rollout.txt failed)"
  echo "rollout-seconds=$(kv rollout.txt rollout-seconds)"
  echo "secret-in-manifest=$(kv secret-count.txt secret-in-manifest)"
  echo "secret-in-plan=$(kv secret-count.txt secret-in-plan)"
  echo "gate-scan-exit=$(kv scan.txt gate-scan-exit)"
  echo "cost-plan-usd=$(kv cost.txt plan-usd)"
  echo "cost-base-usd=$(kv cost.txt base-usd)"
  echo "cost-budget-usd=$(kv cost.txt budget-usd)"
  echo "cost-gate=$(kv cost.txt gate)"
  echo "cost-bypass=$(kv cost.txt bypass)"
} > "${OUT}/evidence.txt"

for f in deployment.json plan.json rollout.txt build.log; do
  if [ -f "${PARTS}/${f}" ]; then cp "${PARTS}/${f}" "${OUT}/${f}"; else echo "evidence: немає частини ${f}" >&2; fi
done

# evidence.txt — без секретів (sub, iss, aud і digest не секрет), тож у лог можна.
cat "${OUT}/evidence.txt"
