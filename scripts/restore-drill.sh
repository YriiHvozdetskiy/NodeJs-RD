#!/usr/bin/env bash
# Restore-drill: останній дамп → ЧИСТИЙ Postgres → звірка контрольного значення.
#
#   bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
#
# Бекап, який ніколи не відновлювали, — це надія, а не бекап. Скрипт:
#   1. бере найсвіжіший backups/*.dump і його .fingerprint (знятий backup.sh
#      у тому самому знімку, що й дамп — «до»);
#   2. піднімає сервіс restore з НОВИМ порожнім томом і перевіряє, що в ньому
#      немає жодної таблиці — відновлення в непорожню базу дає фальшиві
#      duplicate key і нічого не доводить;
#   3. pg_restore --no-owner --single-transaction --exit-on-error;
#   4. рахує те саме контрольне значення у відновленій базі («після»);
#   5. MATCH → код 0, інакше MISMATCH і код 1;
#   6. прибирає контейнер разом із томом — і при успіху, і при падінні.
#
# DATABASE_URL тут потрібен для одного: порівняти живу базу з дампом і показати,
# що саме з неї пропало б, якби відновлювались зараз, — це і є RPO на ділі.
# Жива база, як і в backup.sh, читається в обхід PgBouncer.
#
# KEEP_RESTORE=1 лишає drill-базу піднятою для огляду:
#   docker compose --profile drill exec restore psql -U admin -d marketplace
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
# shellcheck source=scripts/lib/db.sh
source scripts/lib/db.sh

parse_database_url "${DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-${ROOT}/backups}"

LATEST="$(find "${BACKUP_DIR}" -maxdepth 1 -name "${DBU_NAME}-*.dump" 2>/dev/null | sort | tail -1)"
if [ -z "${LATEST}" ]; then
  echo "drill: у ${BACKUP_DIR} немає жодного ${DBU_NAME}-*.dump. Спершу scripts/backup.sh" >&2; exit 1
fi
if [ ! -s "${LATEST}.fingerprint" ]; then
  echo "drill: поруч із ${LATEST} немає .fingerprint — нема з чим звіряти" >&2; exit 1
fi
EXPECTED="$(cat "${LATEST}.fingerprint")"

drill() { docker compose --progress quiet --profile drill "$@"; }
restore_psql() { drill exec -T restore psql -U admin -d marketplace -X -A -t -q -v ON_ERROR_STOP=1 "$@"; }
cleanup() { drill rm -sfv restore >/dev/null 2>&1 || true; }
if [ "${KEEP_RESTORE:-0}" != "1" ]; then trap cleanup EXIT; fi

AGE_MIN=$(perl -e 'printf "%.0f", (time - (stat shift)[9]) / 60' "${LATEST}")
echo "━━━ дамп: $(basename "${LATEST}") · $(du -h "${LATEST}" | awk '{print $1}') · знятий ${AGE_MIN} хв тому"
echo "    до:    ${EXPECTED}"

T0=$(now_ms)

# Залишки попереднього прогону (якщо його вбили до trap) — геть разом із томом.
cleanup
# --renew-anon-volumes: навіть якби контейнер лишився, том не перевикористався б.
drill up -d --wait --renew-anon-volumes restore >/dev/null
T_READY=$(now_ms)

VOLUME="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' \
  "$(drill ps -q restore)")"
TABLES_BEFORE="$(restore_psql -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')")"
echo "━━━ чистий Postgres: том ${VOLUME:0:12}… створений щойно, таблиць у public: ${TABLES_BEFORE}"
if [ "${TABLES_BEFORE}" != "0" ]; then
  echo "drill: база відновлення не порожня — прогін нічого не доведе" >&2; exit 1
fi

T_RESTORE0=$(now_ms)
# --no-owner: власник обʼєктів у дампі — роль із DATABASE_URL, у drill-кластері
# її може не бути. --single-transaction + --exit-on-error: або все, або нічого,
# без напіввідновленої бази й «warning: errors ignored on restore: 3».
drill exec -T restore pg_restore -U admin -d marketplace \
  --no-owner --single-transaction --exit-on-error < "${LATEST}"
T_RESTORED=$(now_ms)

ACTUAL="$(restore_psql -c "${FINGERPRINT_SQL}")"
T_VERIFIED=$(now_ms)
echo "    після: ${ACTUAL}"

echo "━━━ час"
echo "    чистий контейнер готовий:  $(secs $((T_READY - T0))) с"
echo "    pg_restore:                $(secs $((T_RESTORED - T_RESTORE0))) с"
echo "    звірка:                    $(secs $((T_VERIFIED - T_RESTORED))) с"
echo "    RTO drill-у (від старту до перевірених даних): $(secs $((T_VERIFIED - T0))) с"
echo "    RPO розкладу backup.cron (щоночі): до 24 год; цей дамп зараз старший на ${AGE_MIN} хв"

export PGPASSWORD="${DBU_PASS}"
LIVE="$(docker compose exec -T -e PGPASSWORD db \
  psql -h 127.0.0.1 -U "${DBU_USER}" -d "${DBU_NAME}" -X -A -t -q -c "${FINGERPRINT_SQL}" 2>/dev/null || echo 'недоступна')"
if [ "${LIVE}" = "${EXPECTED}" ]; then
  echo "    жива база з моменту дампу не змінилась — відновлення зараз нічого б не втратило"
else
  echo "    жива база зараз: ${LIVE}"
  echo "    різниця з дампом — це те, що втратилося б при відновленні зараз"
fi

if [[ "${EXPECTED}" == *'tables none'* ]]; then
  echo "    ⚠ у дампі жодної таблиці: drill довів лише, що архів відновлюється."
  echo "      Змістовний прогін — після npm run build && npm run migrate && npm run seed."
fi

if [ "${ACTUAL}" = "${EXPECTED}" ]; then
  echo "MATCH"
else
  echo "MISMATCH: очікували '${EXPECTED}', отримали '${ACTUAL}'" >&2
  exit 1
fi
