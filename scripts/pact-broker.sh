#!/usr/bin/env bash
# Pact Broker із командного рядка — ті самі кроки, що в CI-джобі contract.
#
#   bash scripts/pact-broker.sh publish        # pacts/*.json → брокер під версією консюмера
#   bash scripts/pact-broker.sh tag-prod       # тег prod на версію ПРОВАЙДЕРА
#   bash scripts/pact-broker.sh can-i-deploy   # exit 1, якщо deployable не true
#   bash scripts/pact-broker.sh gate           # локальний гейт повністю: «не можна» → «можна»
#
# Адреса й токен — лише з оточення: локально їх кладе scripts/with-secrets.sh
# зі сховища, у CI — secrets GitHub. Без PACT_BROKER_URL скрипт іде в брокер
# із docker-compose.yml: це адреса на loopback, а не секрет.
#
# Версії — короткий хеш коміту, якщо PACT_CONSUMER_VERSION / PACT_PROVIDER_VERSION
# не задані. Дефолт провайдера той самий, що в test/contract/pact.config.ts:
# тег prod має лягти рівно на версію, під якою верифікація опублікувала результат.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CONSUMER=marketplace-web
PROVIDER=marketplace-api
PACT_FILE="pacts/${CONSUMER}-${PROVIDER}.json"

PACT_BROKER_URL="${PACT_BROKER_URL:-http://127.0.0.1:9292}"
export PACT_BROKER_URL
COMMIT="$(git rev-parse --short HEAD)"
CONSUMER_VERSION="${PACT_CONSUMER_VERSION:-${COMMIT}}"
PROVIDER_VERSION="${PACT_PROVIDER_VERSION:-${COMMIT}}"

die() { echo "pact-broker: $*" >&2; exit 1; }
step() { printf '\n── %s\n' "$*"; }

# curl до брокера. Токен іде конфігом через stdin, а не аргументом: аргументи
# процесу видно в `ps` кожному на машині, stdin — ні.
broker() {
  if [ -n "${PACT_BROKER_TOKEN:-}" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "${PACT_BROKER_TOKEN}" | curl -sS -K - "$@"
  else
    curl -sS "$@"
  fi
}

publish() {
  [ -f "${PACT_FILE}" ] || die "немає ${PACT_FILE} — спершу npm run test:contract"
  local code
  code="$(broker -o /dev/null -w '%{http_code}' -X PUT \
    "${PACT_BROKER_URL}/pacts/provider/${PROVIDER}/consumer/${CONSUMER}/version/${CONSUMER_VERSION}" \
    -H 'Content-Type: application/json' -d @"${PACT_FILE}")"
  echo "publish ${CONSUMER}@${CONSUMER_VERSION} → HTTP ${code}"
  # 201 — нова версія контракту, 200 — той самий контракт опубліковано повторно.
  case "${code}" in 200 | 201) ;; *) die "publish не пройшов" ;; esac
}

tag_prod() {
  local code
  code="$(broker -o /dev/null -w '%{http_code}' -X PUT \
    "${PACT_BROKER_URL}/pacticipants/${PROVIDER}/versions/${PROVIDER_VERSION}/tags/prod" \
    -H 'Content-Type: application/json')"
  echo "tag ${PROVIDER}@${PROVIDER_VERSION} → prod: HTTP ${code}"
  case "${code}" in 200 | 201) ;; *) die "тег не поставився" ;; esac
}

# «Чи можна викласти цю версію консюмера туди, де зараз prod-версія провайдера?»
# Вердикт — поле summary.deployable з відповіді брокера, а не exit code верифікації.
can_i_deploy() {
  broker "${PACT_BROKER_URL}/can-i-deploy?pacticipant=${CONSUMER}&version=${CONSUMER_VERSION}&to=prod" |
    node -e '
      let raw = "";
      process.stdin.on("data", (d) => (raw += d)).on("end", () => {
        let summary;
        try { summary = JSON.parse(raw).summary; } catch { console.error(raw); process.exit(1); }
        console.log(JSON.stringify(summary));
        process.exit(summary && summary.deployable === true ? 0 : 1);
      });'
}

gate() {
  export PACT_CONSUMER_VERSION="${CONSUMER_VERSION}" PACT_PROVIDER_VERSION="${PROVIDER_VERSION}"

  step "1/7 брокер з порожнім станом (${PACT_BROKER_URL})"
  docker compose rm -sf pact-broker >/dev/null 2>&1 || true
  docker compose up -d --wait pact-broker

  step "2/7 consumer-тест → ${PACT_FILE}"
  npm run -s test:contract

  step "3/7 publish контракту"
  publish

  step "4/7 provider verification з брокера, publishVerificationResult: true"
  npm run -s verify:provider

  step "5/7 can-i-deploy ДО тега prod — чекаємо unknown"
  if can_i_deploy; then die "deployable:true ще до тега — гейт завжди зелений, так не можна"; fi

  step "6/7 тег prod на версію провайдера"
  tag_prod

  step "7/7 can-i-deploy ПІСЛЯ тега — чекаємо deployable:true"
  can_i_deploy
}

case "${1:-}" in
  publish) publish ;;
  tag-prod) tag_prod ;;
  can-i-deploy) can_i_deploy ;;
  gate) gate ;;
  *) echo "використання: bash scripts/pact-broker.sh publish|tag-prod|can-i-deploy|gate" >&2; exit 2 ;;
esac
