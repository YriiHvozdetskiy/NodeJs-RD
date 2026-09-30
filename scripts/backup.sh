#!/usr/bin/env bash
# Логічний бекап бази курсового: pg_dump -Fc → backups/<db>-<дата UTC>.dump.
#
#   bash scripts/with-secrets.sh dev bash scripts/backup.sh
#
# Підключення — з DATABASE_URL, який кладе в оточення обгортка. Звідти беремо
# роль, пароль і базу. Хост і порт у DATABASE_URL — це PgBouncer, і pg_dump іде
# В ОБХІД нього, у сам сервіс db: pg_dump ставить сесійні SET (search_path,
# statement_timeout…) до свого BEGIN, а в transaction mode сесії немає — ці SET
# потрапили б в інший backend і дісталися б чужому клієнту. Бекапи й адмінські
# задачі ходять повз transaction-пулер, застосунок — через нього.
#
# pg_dump запускається всередині контейнера db: його версія гарантовано та
# сама, що й у сервера. pg_dump 16 з хоста відмовився б дампити Postgres 17.
#
# Поруч із дампом лягає <файл>.fingerprint — контрольне значення бази
# (scripts/lib/db.sh), зняте в ТОМУ САМОМУ знімку, що й дамп. Порахуй його
# окремим запитом до чи після pg_dump, і будь-яка вставка між ними дала б
# фальшивий MISMATCH на drill-і. Тому: транзакція REPEATABLE READ →
# pg_export_snapshot() → контрольне значення → pg_dump --snapshot=<той самий>.
#
# Змінні (необовʼязкові): BACKUP_DIR (типово ./backups), BACKUP_KEEP (типово 14).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
# shellcheck source=scripts/lib/db.sh
source scripts/lib/db.sh

parse_database_url "${DATABASE_URL}"

BACKUP_DIR="${BACKUP_DIR:-${ROOT}/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
mkdir -p "${BACKUP_DIR}"
BACKUP_DIR="$(cd "${BACKUP_DIR}" && pwd)"

NAME="${DBU_NAME}-$(date -u +%Y-%m-%dT%H%M%SZ).dump"
OUT="${BACKUP_DIR}/${NAME}"
TMP_IN_CONTAINER="/tmp/${NAME}"

# Пароль — через оточення процесу docker exec, а не в аргументах: аргументи
# видно в `ps` на хості й у контейнері.
export PGUSER="${DBU_USER}" PGPASSWORD="${DBU_PASS}" PGDATABASE="${DBU_NAME}"
in_db() { docker compose exec -T -e PGUSER -e PGPASSWORD -e PGDATABASE db "$@"; }

cleanup() {
  in_db rm -f "${TMP_IN_CONTAINER}" "${TMP_IN_CONTAINER}.fingerprint" >/dev/null 2>&1 || true
  rm -f "${OUT}.partial"
}
trap cleanup EXIT

T0=$(now_ms)
# -h 127.0.0.1, а не unix-сокет: по сокету в контейнері діє trust, і пароль із
# DATABASE_URL не перевірився б. По TCP діє scram-sha-256 — як у застосунку.
in_db psql -h 127.0.0.1 -X -q -A -t -v ON_ERROR_STOP=1 <<SQL
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot() AS snap \gset
\setenv SNAP :snap
\o ${TMP_IN_CONTAINER}.fingerprint
${FINGERPRINT_SQL};
\o
\! pg_dump -h 127.0.0.1 -Fc --snapshot="\$SNAP" -f ${TMP_IN_CONTAINER} || rm -f ${TMP_IN_CONTAINER}
COMMIT;
SQL
DUMP_MS=$(( $(now_ms) - T0 ))

# Код виходу \! psql не перевіряє, тож доказ успіху pg_dump — непорожній файл.
if ! in_db test -s "${TMP_IN_CONTAINER}"; then
  echo "backup: pg_dump не створив архів" >&2; exit 1
fi

in_db cat "${TMP_IN_CONTAINER}" > "${OUT}.partial"
# pg_restore --list читає TOC — доказ, що це цілий -Fc архів, а не обрізаний
# файл. Перевіряємо ДО того, як файл отримає справжнє імʼя: drill бере
# «останній *.dump», і битий архів не має туди потрапити навіть на мить.
TOC="$(docker compose exec -T db pg_restore --list < "${OUT}.partial")"
TOC_ENTRIES=$(grep -cE '^[0-9]+;' <<< "${TOC}" || true)
in_db cat "${TMP_IN_CONTAINER}.fingerprint" > "${OUT}.fingerprint"
mv "${OUT}.partial" "${OUT}"

# Ротація: лишаємо BACKUP_KEEP найсвіжіших. Імена містять дату UTC у форматі
# ISO, тож лексикографічний порядок = хронологічний.
find "${BACKUP_DIR}" -maxdepth 1 -name "${DBU_NAME}-*.dump" | sort -r \
  | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
      rm -f "${old}" "${old}.fingerprint"
      echo "  видалено старий: $(basename "${old}")"
    done

SIZE_BYTES=$(wc -c < "${OUT}" | tr -d ' ')
echo "backup: ${DBU_NAME} → $(du -h "${OUT}" | awk '{print $1}') (${SIZE_BYTES} B), ${TOC_ENTRIES} обʼєктів у TOC, $(secs "${DUMP_MS}") с"
echo "контрольне значення: $(cat "${OUT}.fingerprint")"
echo "${OUT}"
