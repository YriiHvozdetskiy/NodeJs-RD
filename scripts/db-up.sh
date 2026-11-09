#!/usr/bin/env bash
# Піднімає Postgres, PgBouncer, RabbitMQ, два Redis і сховище файлів і готує файли-секрети. Ідемпотентний: можна запускати скільки завгодно разів.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_SECRET_FILE="${DB_PASSWORD_FILE:-./secrets/db_password}"
ADMIN_SECRET_FILE='./secrets/pg_admin_password'
BROKER_SECRET_FILE="${BROKER_PASSWORD_FILE:-./secrets/rabbitmq_password}"
REDIS_SECRET_FILE="${REDIS_PASSWORD_FILE:-./secrets/redis_password}"

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
# Пароль обох Redis (#23). requirepass приходить аргументом redis-server, тож
# береться заново на кожному старті контейнера — вирівнювати після up нічого.
[ -f "${REDIS_SECRET_FILE}" ] || printf 'redis-%s' "$(openssl rand -hex 16)" > "${REDIS_SECRET_FILE}"
# Ключі доступу до сховища файлів (#26). Це root-пара RustFS: compose бере її з
# STORAGE_ACCESS_KEY/STORAGE_SECRET_KEY, які експортуються нижче. Наявні файли не
# чіпаються — інша пара на тому самому томі означала б іншого власника даних.
[ -f ./secrets/storage_access_key ] || printf 'marketplace-%s' "$(openssl rand -hex 4)" > ./secrets/storage_access_key
[ -f ./secrets/storage_secret_key ] || printf '%s' "$(openssl rand -hex 24)" > ./secrets/storage_secret_key
# Адреса Pact Broker зі сховища (#16) — за замовчуванням брокер із цього compose.
[ -f ./secrets/pact_broker_url ] || printf 'http://127.0.0.1:9292' > ./secrets/pact_broker_url
# Ключ шифрування стану Pulumi (#28): ним зашифровані секрети стеку kind у
# .pulumi/. Наявний не чіпається — новий не розшифрував би вже записаний стан.
[ -f ./secrets/pulumi_passphrase ] || printf 'pulumi-%s' "$(openssl rand -hex 16)" > ./secrets/pulumi_passphrase
# Пари ES256 для dev і prod, їхні kid і перці refresh-токенів (#24). Наявні не
# чіпаються: перегенерація ключа вбила б усі живі токени.
node scripts/jwt-keys.mjs init

PG_ADMIN_PASSWORD="$(cat "${ADMIN_SECRET_FILE}")"
export PG_ADMIN_PASSWORD
RABBITMQ_PASSWORD="$(cat "${BROKER_SECRET_FILE}")"
export RABBITMQ_PASSWORD
REDIS_PASSWORD="$(cat "${REDIS_SECRET_FILE}")"
export REDIS_PASSWORD
STORAGE_ACCESS_KEY="$(cat ./secrets/storage_access_key)"
STORAGE_SECRET_KEY="$(cat ./secrets/storage_secret_key)"
export STORAGE_ACCESS_KEY STORAGE_SECRET_KEY
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
echo "RabbitMQ — на 127.0.0.1:5672 (UI: http://127.0.0.1:15672), Redis кешу — на 127.0.0.1:6379,"
echo "Redis черги — на 127.0.0.1:6380, сховище файлів (S3 API) — на 127.0.0.1:22650 (консоль: http://127.0.0.1:22651);"
echo "паролі й ключі вирівняні з secrets/."
echo "Далі:"
echo "  npm run start:vault                 # застосунок на :3000; ключі підпису — з secrets/jwt/dev/"
echo "  curl -s localhost:3000/health/db    # запит через пул"
echo "  npm run rotate                      # ротація пароля без рестарту"
echo "  npm run build && npm run migrate    # схема через міграції TypeORM"
echo "  npm run consumer                    # споживач order.placed (#19)"
echo "  npm run worker                      # воркер черги BullMQ (#23)"
echo "  npm run edge                        # кеш-шар перед сховищем на :22660 (#26)"
