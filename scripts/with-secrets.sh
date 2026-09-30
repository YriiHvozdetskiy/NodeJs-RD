#!/usr/bin/env bash
# Запускає команду з параметрами підключення до БД у process.env.
#
#   bash scripts/with-secrets.sh dev typeorm migration:run -d dist/data-source.js
#   bash scripts/with-secrets.sh dev            # без команди — npm run start
#
# Сховище — те, що зафіксовано на ДЗ #11: адреса бази лежить у .env (DB_URL,
# без пароля), пароль — у гітігнорному файлі-секреті. Обгортка перекладає їх
# у DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME і робить exec, тож секрет
# живе лише в оточенні процесу-нащадка: ні в git, ні в історії shell, ні в
# аргументах команди, які видно в `ps`.
#
# Міграції й seed ходять власником схеми (admin), а не app_user: з Postgres 15
# у звичайної ролі немає CREATE на schema public, і DDL від app_user упав би
# з permission denied. Застосунок, як і раніше, ходить app_user.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_SLUG="${1:-dev}"; shift || true
[ "$#" -gt 0 ] || set -- npm run start

# грейдер не має доступу до сховища: значення вже в оточенні
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

case "${ENV_SLUG}" in
  dev) ;;
  *) echo "with-secrets: невідоме оточення '${ENV_SLUG}' (є лише dev)" >&2; exit 2 ;;
esac

ENV_FILE="${ROOT}/.env"
ADMIN_SECRET_FILE="${ROOT}/secrets/pg_admin_password"

if [ ! -f "${ENV_FILE}" ]; then
  echo "with-secrets: немає ${ENV_FILE}. Спершу: cp .env.example .env" >&2; exit 1
fi
if [ ! -f "${ADMIN_SECRET_FILE}" ]; then
  echo "with-secrets: немає ${ADMIN_SECRET_FILE}. Спершу: npm run db:up" >&2; exit 1
fi

# Беремо з .env рівно один ключ, а не `source` усього файла: .env — це
# key=value для dotenv, не shell-скрипт, і виконувати його як код не можна.
DB_URL="$(grep -E '^DB_URL=' "${ENV_FILE}" | tail -1 | cut -d= -f2- | tr -d '"'"'"'')"
if [ -z "${DB_URL}" ]; then
  echo "with-secrets: у ${ENV_FILE} немає DB_URL" >&2; exit 1
fi

# postgres://user@host:port/db → частини. Користувача з URL не беремо навмисно
# (там app_user, див. вище).
rest="${DB_URL#*://}"; rest="${rest#*@}"
hostport="${rest%%/*}"
DB_NAME="${rest#*/}"; DB_NAME="${DB_NAME%%\?*}"
DB_HOST="${hostport%%:*}"
if [[ "${hostport}" == *:* ]]; then DB_PORT="${hostport##*:}"; else DB_PORT=5432; fi

export DB_HOST DB_PORT DB_NAME
export DB_USER=admin
DB_PASSWORD="$(cat "${ADMIN_SECRET_FILE}")"
export DB_PASSWORD

exec "$@"
