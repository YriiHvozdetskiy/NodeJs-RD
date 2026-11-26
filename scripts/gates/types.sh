#!/usr/bin/env bash
# Сходинка 1 конвеєра (#32): типи й стиль.
#
#   bash scripts/gates/types.sh [корінь-дерева]     # за замовчуванням — корінь репо
#
# Той самий скрипт запускає і джоба quality у ci.yml (на дереві PR), і demo:gates
# (двічі: на дереві репо і на копії з зумисною одруковкою в типі). Корінь —
# параметром, щоб гейт не знав, яке дерево йому дали.
#
# Обидва інструменти біжать завжди, навіть якщо перший уже сказав «ні»: у лозі
# PR видно всі зауваження одразу, а не по одному за прогін. Код виходу —
# ненульовий, якщо «ні» сказав хоч один.
set -uo pipefail
ROOT="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd)"
cd "${ROOT}"

# Бінарники з node_modules дерева, а не через npx: npx без локального пакета
# пішов би в мережу по свіжу версію — і гейт перевіряв би не тим інструментом.
BIN="${ROOT}/node_modules/.bin"

"${BIN}/tsc" -p tsconfig.json --noEmit;      tsc_app=$?
"${BIN}/tsc" -p tsconfig.test.json --noEmit; tsc_test=$?
"${BIN}/eslint" src test;                    eslint=$?

echo "types: tsc(src)=${tsc_app} tsc(src+test)=${tsc_test} eslint=${eslint}" >&2
[ "${tsc_app}" -eq 0 ] && [ "${tsc_test}" -eq 0 ] && [ "${eslint}" -eq 0 ]
