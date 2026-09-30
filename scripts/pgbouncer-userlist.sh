#!/usr/bin/env bash
# Збирає userlist PgBouncer із файлів-секретів і, якщо PgBouncer уже працює,
# просить його перечитати файл (SIGHUP = RELOAD). Викликають db-up.sh і rotate.sh.
#
# PgBouncer логіниться в Postgres тими самими паролями, якими перевіряє
# клієнтів, тож після ротації в Postgres userlist мусить змінитися теж — інакше
# перше ж нове серверне зʼєднання app_user впаде з «password authentication failed».
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_SECRET_FILE="${DB_PASSWORD_FILE:-./secrets/db_password}"
ADMIN_SECRET_FILE='./secrets/pg_admin_password'
USERLIST='./secrets/pgbouncer_userlist.txt'

mtime() { perl -e 'print +(stat shift)[9] // 0' "$1"; }
OLD_MTIME="$(mtime "${USERLIST}")"

# `>` переписує файл на місці, не міняючи inode. Це важливо: compose монтує
# сам файл, і bind mount тримається за inode — файл, замінений через rename,
# контейнер уже не побачив би. Права — як у решти secrets/ (0644): PgBouncer у
# контейнері працює як uid 70, і на Linux-хості файл 0600 чужого власника він
# не прочитав би.
printf '"admin" "%s"\n"app_user" "%s"\n' \
  "$(cat "${ADMIN_SECRET_FILE}")" "$(cat "${APP_SECRET_FILE}")" > "${USERLIST}"

# PgBouncer на RELOAD перечитує auth_file, лише якщо змінились його mtime
# (секунди) або розмір. Розмір у нас сталий — паролі однакової довжини, — тож
# дві ротації в межах однієї секунди давали той самий mtime, і RELOAD мовчки
# лишав старий пароль. Заміряно: 3 з 8 ротацій поспіль. Тому mtime зсуваємо
# примусово, якщо він не змінився.
if [ "$(mtime "${USERLIST}")" = "${OLD_MTIME}" ]; then
  perl -e 'utime undef, $ARGV[0] + 1, $ARGV[1]' "${OLD_MTIME}" "${USERLIST}"
fi

# db-up.sh просить лише згенерувати файл: PgBouncer він потім перестворить сам.
if [ "${NO_RELOAD:-0}" = "1" ]; then exit 0; fi

CID="$(docker compose ps -q --status running pgbouncer 2>/dev/null)"
if [ -z "${CID}" ]; then exit 0; fi
# Контейнер, піднятий голим `docker compose up`, монтує дев-файл із репо, а не
# цей. Перечитувати тоді нічого: наступний `npm run db:up` перестворить його
# з правильним монтуванням.
MOUNTED="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/pgbouncer/userlist.txt"}}{{.Source}}{{end}}{{end}}' "${CID}")"
if [ "${MOUNTED}" != "$(pwd)/${USERLIST#./}" ]; then
  echo "pgbouncer-userlist: PgBouncer змонтував ${MOUNTED:-?}, а не ${USERLIST} — RELOAD пропущено, потрібен npm run db:up" >&2
  exit 0
fi

docker compose --progress quiet kill -s HUP pgbouncer

# RELOAD підтверджуємо результатом, а не вірою: логін через PgBouncer новим
# паролем app_user має пройти, перш ніж rotate.sh рве старі серверні
# зʼєднання. Кілька спроб — бо сигнал обробляється асинхронно.
export PGPASSWORD
PGPASSWORD="$(cat "${APP_SECRET_FILE}")"
for _ in $(seq 1 10); do
  if docker compose exec -T -e PGPASSWORD pgbouncer \
       psql -h 127.0.0.1 -p 6432 -U app_user -d marketplace -XAtqc 'SELECT 1' >/dev/null 2>&1; then
    exit 0
  fi
done
echo "pgbouncer-userlist: PgBouncer не прийняв новий пароль app_user після RELOAD" >&2
exit 1
