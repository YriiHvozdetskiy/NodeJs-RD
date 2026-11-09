#!/usr/bin/env bash
# npm run scan (#28) — сканування образу з порогом, і поріг ОБЧИСЛЮЄТЬСЯ.
#
#   SCAN_MAX=-1    npm run scan   # gate=fail, exit 1 — знахідок завжди ≥ 0 > -1
#   SCAN_MAX=99999 npm run scan   # gate=pass, exit 0
#
# Вердикт рахується з JSON-звіту Trivy: found — кількість знахідок потрібної
# серйозності у звіті, gate — порівняння found із SCAN_MAX. Надрукованого
# заздалегідь висновку тут немає: той самий скрипт із різним порогом дає різний
# вердикт і різний код виходу.
#
# Trivy — контейнером із запіненою версією, тож ставити його не треба. База
# вразливостей кешується в томі marketplace-trivy-cache і оновлюється щодоби —
# тому found між днями плаває, а критерій дивиться на вердикт, не на число.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE="${IMAGE:-marketplace-api:hw28}"
SEVERITY="${SCAN_SEVERITY:-CRITICAL,HIGH}"
# Робочий поріг — «не гірше, ніж зараз» (ratchet): CI падає, якщо з новою
# залежністю чи базою знахідок стало більше. Розбір чисел — README, розділ Kubernetes.
MAX="${SCAN_MAX:-12}"
TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.74.0}"

if ! [[ "${MAX}" =~ ^-?[0-9]+$ ]]; then
  echo "scan: SCAN_MAX має бути цілим числом, отримано '${MAX}'" >&2
  exit 2
fi
docker image inspect "${IMAGE}" >/dev/null 2>&1 || { echo "scan: немає образу ${IMAGE} — спершу npm run image:build" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/scan.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

# Образ — архівом через `docker save`, а не через сокет Docker у контейнері
# сканера: сканеру не потрібен доступ до демона, а отже й до всіх контейнерів машини.
docker save "${IMAGE}" -o "${WORK}/image.tar"

# Звіт — у stdout контейнера, а не у файл у змонтованій теці: на Linux файл
# належав би root, і trap не зміг би його прибрати.
if ! docker run --rm \
  -v "${WORK}/image.tar:/scan/image.tar:ro" \
  -v marketplace-trivy-cache:/root/.cache/trivy \
  "${TRIVY_IMAGE}" image --input /scan/image.tar \
  --severity "${SEVERITY}" --format json --quiet --timeout 10m > "${WORK}/report.json"; then
  echo "image=${IMAGE}"
  echo "gate=error"
  echo "scan: сканер не відпрацював — вердикту немає, і це не pass" >&2
  exit 3
fi

# found — усі знахідки потрібної серйозності; fixable — ті, для яких є версія з
# виправленням (можна прибрати оновленням бази чи залежності).
read -r FOUND FIXABLE < <(node -e '
  const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const wanted = new Set(process.argv[2].split(","));
  const vulns = (report.Results ?? []).flatMap((r) => r.Vulnerabilities ?? []).filter((v) => wanted.has(v.Severity));
  console.log(vulns.length, vulns.filter((v) => v.FixedVersion).length);
' "${WORK}/report.json" "${SEVERITY}")

if [ "${FOUND}" -le "${MAX}" ]; then GATE=pass; else GATE=fail; fi

echo "image=${IMAGE}"
echo "severity=${SEVERITY}"
echo "found=${FOUND}"
echo "fixable=${FIXABLE}"
echo "max-allowed=${MAX}"
echo "gate=${GATE}"

[ "${GATE}" = "pass" ]
