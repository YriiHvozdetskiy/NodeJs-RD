#!/usr/bin/env bash
# Сходинка 3 конвеєра (#32): архітектура — заборонені імпорти між модулями.
#
#   bash scripts/gates/arch.sh [корінь-дерева]
#
# Правила — у .dependency-cruiser.cjs дерева, кожне з них — речення з README
# (розділ CI/CD → Архітектура). Код виходу depcruise — кількість порушень рівня
# error, тобто 0 лише тоді, коли жодне правило не зачеплене.
set -euo pipefail
ROOT="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd)"
cd "${ROOT}"

"${ROOT}/node_modules/.bin/depcruise" --config .dependency-cruiser.cjs --output-type err src
