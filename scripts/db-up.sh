#!/usr/bin/env bash
# Піднімає Postgres, PgBouncer і RabbitMQ і готує файли-секрети. Ідемпотентний: можна запускати скільки завгодно разів.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_SECRET_FILE="${DB_PASSWORD_FILE:-./secrets/db_password}"
ADMIN_SECRET_FILE='./secrets/pg_admin_password'
BROKER_SECRET_FILE="${BROKER_PASSWORD_FILE:-./secrets/rabbitmq_password}"

# На робочій машині всі паролі ГЕНЕРУЮТЬСЯ:
#   • app_user  — db/init.sql створює роль без пароля, значення ставить ALTER нижче;
#   • admin     — compose бере його з PG_ADMIN_PASSWORD, яку ми експортуємо з файла;
#   • app у RabbitMQ — compose бере його з RABBITMQ_PASSWORD, так само.
#     Дев-дефолти з compose лишаються тільки для свіжого клону без цього скрипта.
mkdir -p "$(dirname "${APP_SECRET_FILE}")"
[ -f "${APP_SECRET_FILE}" ] || printf 'app-%s' "$(openssl rand -hex 16)" > "${APP_SECRET_FILE}"
[ -f "${ADMIN_SECRET_FILE}" ] || printf 'admin-%s' "$(openssl rand -hex 16)" > "${ADMIN_SECRET_FILE}"
# Пароль користувача app у RabbitMQ (#19). hex — щоб у amqp://user:pass@… не
# було чого кодувати.
[ -f "${BROKER_SECRET_FILE}" ] || printf 'rmq-%s' "$(openssl rand -hex 16)" > "${BROKER_SECRET_FILE}"
# Адреса Pact Broker зі сховища (#16) — за замовчуванням брокер із цього compose.
[ -f ./secrets/pact_broker_url ] || printf 'http://127.0.0.1:9292' > ./secrets/pact_broker_url

PG_ADMIN_PASSWORD="$(cat "${ADMIN_SECRET_FILE}")"
export PG_ADMIN_PASSWORD
RABBITMQ_PASSWORD="$(cat "${BROKER_SECRET_FILE}")"
export RABBITMQ_PASSWORD
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

# RABBITMQ_DEFAULT_PASS, як і POSTGRES_PASSWORD, діє лише на порожньому томі.
# На наявному томі пароль app вирівнюємо так само, як ролі Postgres вище.
docker compose exec -T rabbit rabbitmqctl -q change_password app "${RABBITMQ_PASSWORD}" >/dev/null

echo "Postgres готовий на 127.0.0.1:5432, PgBouncer — на 127.0.0.1:6432, Pact Broker — на 127.0.0.1:9292,"
echo "RabbitMQ — на 127.0.0.1:5672 (UI: http://127.0.0.1:15672); паролі вирівняні з secrets/."
echo "Далі:"
echo "  npm run start                       # застосунок на :3000"
echo "  curl -s localhost:3000/health/db    # запит через пул"
echo "  npm run rotate                      # ротація пароля без рестарту"
echo "  npm run build && npm run migrate    # схема через міграції TypeORM"
echo "  npm run consumer                    # споживач order.placed (#19)"
