#!/usr/bin/env bash
# Збирає production-образ (#28): docker/Dockerfile -> marketplace-api:hw28.
#
# Токен приватного реєстру їде в збірку лише як BuildKit-секрет із файла
# .npm_token (у git і в build-контексті його немає). Приватного реєстру в
# проєкту немає, тож це приманка з випадковим рядком: demo:image шукає її в
# історії, конфігу й шарах образу.
#
#   printf 'npm_decoy_%s' "$(openssl rand -hex 12)" > .npm_token
#   npm run image:build
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE="${IMAGE:-marketplace-api:hw28}"
TOKEN_FILE="${NPM_TOKEN_FILE:-.npm_token}"

if [ ! -s "${TOKEN_FILE}" ]; then
  echo "image:build: немає ${TOKEN_FILE} — секрету етапу збірки." >&2
  echo "  printf 'npm_decoy_%s' \"\$(openssl rand -hex 12)\" > ${TOKEN_FILE}" >&2
  exit 1
fi

DOCKER_BUILDKIT=1 docker build \
  --file docker/Dockerfile \
  --secret "id=npm_token,src=${TOKEN_FILE}" \
  --tag "${IMAGE}" \
  .

# Відбиток збірки: який образ і яким токеном зібрано. demo:image шукає в образі
# рядок із .npm_token і без цієї звірки на перегенерованому файлі показав би
# тихий нуль. Сам токен сюди не пишеться — лише його sha256; файл у .gitignore.
STAMP_FILE="${IMAGE_STAMP_FILE:-.image-build}"
token_sha="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "${TOKEN_FILE}")"
printf 'image=%s\nid=%s\ntoken-sha256=%s\n' \
  "${IMAGE}" "$(docker image inspect --format '{{.Id}}' "${IMAGE}")" "${token_sha}" > "${STAMP_FILE}"

echo "image=${IMAGE}"
