#!/usr/bin/env bash
# Піднімає Postgres і готує файл-секрет. Ідемпотентний: можна запускати скільки завгодно разів.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SECRET_FILE="${DB_PASSWORD_FILE:-./secrets/db_password}"
BOOTSTRAP_PASSWORD='app-v1-password' # те саме значення, що в db/init.sql

mkdir -p "$(dirname "${SECRET_FILE}")"
[ -f "${SECRET_FILE}" ] || printf '%s' "${BOOTSTRAP_PASSWORD}" > "${SECRET_FILE}"

docker compose up -d --wait

# Вирівнюємо пароль ролі зі вмістом файла. Потрібно у двох випадках:
#   • контейнер уже існував — init.sql не перевиконується, а файл міг бути ротований;
#   • том щойно перестворений (`down -v`) — роль повернулась до пароля з init.sql,
#     а файл лишився з ротованим значенням.
# Без цього рядка другий сценарій дає «password authentication failed» —
# найчастіша пастка цього ДЗ.
docker compose exec -T db psql -U admin -d marketplace \
  -c "ALTER ROLE app_user WITH PASSWORD '$(cat "${SECRET_FILE}")';" >/dev/null

echo "Postgres готовий на 127.0.0.1:5432, пароль app_user вирівняний із ${SECRET_FILE}."
echo "Далі:"
echo "  npm run start                       # застосунок на :3000"
echo "  curl -s localhost:3000/health/db    # запит через пул"
echo "  npm run rotate                      # ротація пароля без рестарту"
