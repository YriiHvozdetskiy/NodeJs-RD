#!/usr/bin/env bash
# Піднімає Postgres і готує файли-секрети. Ідемпотентний: можна запускати скільки завгодно разів.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_SECRET_FILE="${DB_PASSWORD_FILE:-./secrets/db_password}"
ADMIN_SECRET_FILE='./secrets/pg_admin_password'

# Обидва паролі ГЕНЕРУЮТЬСЯ, а не зашиті. Хардкоду більше немає ніде:
#   • app_user  — db/init.sql створює роль без пароля, значення ставить ALTER нижче;
#   • admin     — compose віддає його Postgres'у файлом (POSTGRES_PASSWORD_FILE),
#     тож у git лежить лише ім'я файла, не значення.
mkdir -p "$(dirname "${APP_SECRET_FILE}")"
[ -f "${APP_SECRET_FILE}" ] || printf 'app-%s' "$(openssl rand -hex 16)" > "${APP_SECRET_FILE}"
[ -f "${ADMIN_SECRET_FILE}" ] || printf 'admin-%s' "$(openssl rand -hex 16)" > "${ADMIN_SECRET_FILE}"

docker compose up -d --wait

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

echo "Postgres готовий на 127.0.0.1:5432, паролі ролей вирівняні з secrets/."
echo "Далі:"
echo "  npm run start                       # застосунок на :3000"
echo "  curl -s localhost:3000/health/db    # запит через пул"
echo "  npm run rotate                      # ротація пароля без рестарту"
