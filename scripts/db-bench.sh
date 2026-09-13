#!/usr/bin/env bash
# Повний цикл перевірки дата-шару на чистому томі — той самий порядок, що в грейдера:
#   down -v → up → schema → seed → EXPLAIN «до» → indexes → ANALYZE → EXPLAIN «після» → мертві індекси.
# Плани лягають у теку $1 (типово $TMPDIR/db-bench); з них зібраний db/OPTIMIZATIONS.md.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT="${1:-${TMPDIR:-/tmp}/db-bench}"
mkdir -p "$OUT"

# Той самий psql, що й у README: усередині контейнера, unix-сокет, без пароля.
# -w / — робочий каталог контейнера, тож db/… з репозиторію видно як /db/… (mount у compose).
psql() { docker compose exec -T -w / db psql -U admin -d marketplace -v ON_ERROR_STOP=1 "$@"; }
explain() { psql -c "EXPLAIN (ANALYZE, BUFFERS) $(cat "db/queries/$1.sql")"; }

echo "== чистий том"
docker compose down -v
bash scripts/db-up.sh

echo "== schema"
psql -f db/schema.sql
echo "== seed"
time psql -f db/seed.sql

echo "== EXPLAIN до індексів"
for q in q1 q2 q3 q4; do
  explain "$q" > "$OUT/$q-before.txt"
  grep -c 'Seq Scan' "$OUT/$q-before.txt" >/dev/null && echo "$q: Seq Scan є" || echo "$q: Seq Scan ВІДСУТНІЙ"
done

echo "== indexes + ANALYZE"
psql -f db/indexes.sql
psql -c "ANALYZE;"

echo "== EXPLAIN після індексів (кожен тричі, беремо останній)"
for q in q1 q2 q3 q4; do
  for _ in 1 2 3; do explain "$q" > "$OUT/$q-after.txt"; done
  if grep -q 'Seq Scan' "$OUT/$q-after.txt"; then echo "$q: Seq Scan ЛИШИВСЯ"; else echo "$q: $(grep -oE '(Index Only Scan using|Index Scan( Backward)? using|Bitmap Index Scan on) \S+' "$OUT/$q-after.txt" | head -1)"; fi
done

echo "== мертві індекси (порожньо = добре)"
psql -Atc "SELECT indexrelname FROM pg_stat_user_indexes WHERE schemaname='public' AND idx_scan = 0 AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conindid <> 0);" | tee "$OUT/dead-indexes.txt"

echo "== морфологія"
psql -Atc "SELECT 'кросівки', count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівки')
           UNION ALL SELECT 'кросівок', count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівок');" | tee "$OUT/morphology.txt"

echo "== плани збережено в $OUT"
