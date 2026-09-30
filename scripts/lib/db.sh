# Спільне для scripts/backup.sh, scripts/restore-drill.sh і scripts/with-secrets.sh.
# Підключається через `source`, сам не запускається.
# shellcheck shell=bash disable=SC2034  # DBU_* і FINGERPRINT_SQL читають ті, хто підключає

# postgres://user:password@host:port/db?params → DBU_USER DBU_PASS DBU_HOST DBU_PORT DBU_NAME.
# Пароль із `@` чи `:` має бути закодований у URL (%40, %3A) — розкодовуємо.
parse_database_url() {
  local url="$1" rest creds hostport
  case "${url}" in
    postgres://*|postgresql://*) ;;
    *) echo "DATABASE_URL має починатися з postgres://" >&2; return 1 ;;
  esac
  rest="${url#*://}"
  creds="${rest%@*}"
  if [ "${creds}" = "${rest}" ]; then
    echo "у DATABASE_URL немає user:password@" >&2; return 1
  fi
  rest="${rest##*@}"
  DBU_USER="$(urldecode "${creds%%:*}")"
  if [[ "${creds}" == *:* ]]; then DBU_PASS="$(urldecode "${creds#*:}")"; else DBU_PASS=''; fi
  hostport="${rest%%/*}"
  DBU_NAME="${rest#*/}"; DBU_NAME="${DBU_NAME%%\?*}"
  DBU_HOST="${hostport%%:*}"
  if [[ "${hostport}" == *:* ]]; then DBU_PORT="${hostport##*:}"; else DBU_PORT=5432; fi
}

urldecode() { printf '%b' "${1//\%/\\x}"; }

# Мілісекунди, а не $SECONDS: відновлення невеликої бази триває менше секунди,
# і цілочисельний лічильник показав би «0 с». EPOCHREALTIME є в bash >= 5,
# на bash 3.2 (дефолт macOS) — perl. `node -p Date.now()` не годиться: старт
# процесу node (~20 мс) потрапляв би всередину виміряного інтервалу.
if [ -n "${EPOCHREALTIME:-}" ]; then
  now_ms() { local t="${EPOCHREALTIME/[.,]/}"; echo "${t:0:${#t}-3}"; }
else
  now_ms() { perl -MTime::HiRes -e 'printf("%.0f\n", Time::HiRes::time() * 1000)'; }
fi
secs() { awk -v ms="$1" 'BEGIN { printf "%.2f", ms / 1000 }'; }

# Контрольне значення бази одним рядком:
#   • ключова таблиця orders — count(*) і sum(total_cents): рядок, що загубився
#     чи змінив суму, змінює цей агрегат;
#   • точна кількість рядків у КОЖНІЙ таблиці public — щоб відновлення, яке
#     загубило, скажімо, points_entries, не пройшло лише тому, що orders ціле.
# query_to_xml виконує динамічний SQL усередині одного SELECT — без функцій і
# без DO-блоків, тож запит однаково працює в транзакції бекапу й у drill-базі.
# На порожній схемі (свіжий клон без міграцій) дає «orders absent · tables none».
FINGERPRINT_SQL="
SELECT concat_ws(' · ',
  'orders[count|sum(total_cents)]=' || CASE
    WHEN to_regclass('public.orders') IS NULL THEN 'absent'
    ELSE (xpath('/row/v/text()', query_to_xml(
      'SELECT count(*) || ''|'' || coalesce(sum(total_cents), 0) AS v FROM public.orders',
      false, true, '')))[1]::text
  END,
  'tables ' || coalesce((
    SELECT string_agg(format('%s=%s', c.relname,
             (xpath('/row/n/text()', query_to_xml(
               format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname),
               false, true, '')))[1]::text), ',' ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ), 'none'))"
