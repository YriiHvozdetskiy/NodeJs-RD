#!/usr/bin/env bash
# Ротація пароля app_user БЕЗ рестарту застосунку.
#
# Чому це взагалі можливо: пароль лежить у файлі, а не в оточенні процесу, і в
# pg.Pool поле password — функція, яку драйвер викликає на кожне НОВЕ з'єднання
# (src/db/database.service.ts). Postgres перевіряє пароль лише під час
# handshake, тож відкриті з'єднання ротацію не помічають, а нові беруть свіже
# значення з файла.
#
# Порядок кроків важливий:
#   1. ALTER ROLE у БД — нове значення стає істиною;
#   2. ОДРАЗУ оновити файл — щоб нові з'єднання йшли вже з новим паролем;
#   3. прибити старі з'єднання — щоб наступний запит довів, що механізм працює,
#      а не просто перевикористав з'єднання зі старим паролем.
#
# Між 1 і 2 є вікно у мілісекунди, коли нове з'єднання зі старим паролем впаде.
# У продакшн-менеджерах (AWS Secrets Manager rotation, Vault database engine)
# це лікують ДВОМА користувачами, що чергуються: поки живе user_a — ротують
# user_b, і вікна немає взагалі.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

SECRET_FILE="${DB_PASSWORD_FILE:-./secrets/db_password}"
DB_ROLE="${DB_ROLE:-app_user}"

if [ ! -f "${SECRET_FILE}" ]; then
  echo "Файла-секрета ${SECRET_FILE} немає. Спершу: npm run db:up" >&2
  exit 1
fi

NEW_PASSWORD="app-$(openssl rand -hex 8)"

echo "1. ALTER ROLE ${DB_ROLE} у Postgres…"
docker compose exec -T db psql -U admin -d marketplace \
  -c "ALTER ROLE ${DB_ROLE} WITH PASSWORD '${NEW_PASSWORD}';" >/dev/null

echo "2. Оновлюю файл-секрет ${SECRET_FILE}…"
printf '%s' "${NEW_PASSWORD}" > "${SECRET_FILE}"

echo -n "3. Закриваю старі з'єднання ${DB_ROLE} (закрито): "
docker compose exec -T db psql -U admin -d marketplace -tA \
  -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = '${DB_ROLE}';"

echo
# У stdout НЕМАЄ жодного байта нового пароля — навіть префікса. Логи CI
# зберігаються вічно, і «перші 6 символів» — це вже залишок секрета.
echo "Готово: новий пароль уже і в БД, і у файлі ${SECRET_FILE}."
echo "Застосунок НЕ рестартував — перевір, що uptime не обнулився:"
echo "  curl -s localhost:3000/health/db"
