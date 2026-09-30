#!/usr/bin/env bash
# Піднімає Postgres і PgBouncer і готує файли-секрети. Ідемпотентний: можна запускати скільки завгодно разів.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_SECRET_FILE="${DB_PASSWORD_FILE:-./secrets/db_password}"
ADMIN_SECRET_FILE='./secrets/pg_admin_password'

# На робочій машині обидва паролі ГЕНЕРУЮТЬСЯ:
#   • app_user  — db/init.sql створює роль без пароля, значення ставить ALTER нижче;
#   • admin     — compose бере його з PG_ADMIN_PASSWORD, яку ми експортуємо з файла.
#     Дев-дефолт із compose лишається тільки для свіжого клону без цього скрипта.
mkdir -p "$(dirname "${APP_SECRET_FILE}")"
[ -f "${APP_SECRET_FILE}" ] || printf 'app-%s' "$(openssl rand -hex 16)" > "${APP_SECRET_FILE}"
[ -f "${ADMIN_SECRET_FILE}" ] || printf 'admin-%s' "$(openssl rand -hex 16)" > "${ADMIN_SECRET_FILE}"

PG_ADMIN_PASSWORD="$(cat "${ADMIN_SECRET_FILE}")"
export PG_ADMIN_PASSWORD
# PgBouncer отримує userlist зі згенерованих паролів, а не дев-файл із репо.
NO_RELOAD=1 bash scripts/pgbouncer-userlist.sh
export PGBOUNCER_USERLIST=./secrets/pgbouncer_userlist.txt
# Спершу лише db: healthcheck PgBouncer логіниться адміном, і на томі, де пароль
# ще старий, він не пройшов би до ALTER ROLE нижче — `--wait` висів би вічно.
docker compose up -d --wait db

# Вирівнюємо паролі ролей зі вмістом файлів. Потрібно у двох випадках:
#   • контейнер уже існував — init.sql не перевиконується, а файли могли ротуватись;
#   • том щойно перестворений (`down -v`) — app_user знову без пароля,
#     а файл лишився з ротованим значенням.
# psql тут ходить через unix-сокет усередині контейнера (trust), тому пароля
# не потребує — саме тому rotate.sh працює і після зміни пароля адміна.
docker compose exec -T db psql -U admin -d marketplace \
  -c "ALTER ROLE app_user WITH PASSWORD '$(cat "${APP_SECRET_FILE}")';" >/dev/null
docker compose exec -T db psql -U admin -d marketplace \
  -c "ALTER ROLE admin WITH PASSWORD '$(cat "${ADMIN_SECRET_FILE}")';" >/dev/null

docker compose up -d --wait

echo "Postgres готовий на 127.0.0.1:5432, PgBouncer — на 127.0.0.1:6432; паролі ролей вирівняні з secrets/."
echo "Далі:"
echo "  npm run start                       # застосунок на :3000"
echo "  curl -s localhost:3000/health/db    # запит через пул"
echo "  npm run rotate                      # ротація пароля без рестарту"
echo "  npm run build && npm run migrate    # схема через міграції TypeORM"
