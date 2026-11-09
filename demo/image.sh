#!/usr/bin/env bash
# demo:image (#28) — чи образ production-grade і чи не осів у ньому секрет збірки.
#
# Кожне число нижче ВИМІРЯНЕ з образу, а не прочитане з Dockerfile:
#   stages            — скільки FROM у docker/Dockerfile (єдине, що читається з файла);
#   shell-inside      — спроба запустити sh / bash / busybox sh у контейнері;
#   runtime-uid       — uid процесу node, яким образ стартує;
#   token-in-history  — рядків `docker history --no-trunc` із токеном;
#   token-in-config   — входжень токена в `docker image inspect` (ENV, LABEL, Cmd…);
#   token-in-layers   — шарів розпакованого `docker save`, у байтах яких є токен.
#
# Три канали, бо жоден інструмент не бачить обидва витоки: ARG видно в історії,
# але не в шарах; COPY + rm наступним шаром — навпаки.
#
# CONTROL=1 додатково збирає навмисно дірявий образ (ARG→ENV + COPY токена) і
# друкує ті самі лічильники з префіксом control- — доказ, що лічильник витік бачить.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE="${IMAGE:-marketplace-api:hw28}"
TOKEN_FILE="${NPM_TOKEN_FILE:-.npm_token}"
DOCKERFILE="docker/Dockerfile"

[ -s "${TOKEN_FILE}" ] || { echo "demo:image: немає ${TOKEN_FILE} — нема чого шукати в образі" >&2; exit 1; }
docker image inspect "${IMAGE}" >/dev/null 2>&1 || { echo "demo:image: немає образу ${IMAGE} — спершу npm run image:build" >&2; exit 1; }
TOKEN="$(cat "${TOKEN_FILE}")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/demo-image.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

# Скільки шарів розпакованого `docker save` містять рядок у своїх байтах.
# Список шарів — з manifest.json архіву: конфіг образу (ENV, історія) теж лежить
# в архіві окремим файлом, але це канал token-in-config, а не шар.
# Шар буває стиснутим (OCI, containerd image store) або голим tar — пробуємо обидва.
count_in_layers() {
  local image="$1" needle="$2" dir="$3" hits=0 layer
  mkdir -p "${dir}"
  docker save "${image}" -o "${dir}/image.tar"
  tar -xf "${dir}/image.tar" -C "${dir}"
  rm -f "${dir}/image.tar"
  while IFS= read -r layer; do
    if [ "$(head -c 2 "${dir}/${layer}" | od -An -tx1 | tr -d ' \n')" = "1f8b" ]; then
      # grep -c, а не -q: -q виходить на першому збігу, gzip ловить SIGPIPE, і
      # з pipefail уся труба вважалась би невдалою — тобто «не знайдено».
      gzip -dc "${dir}/${layer}" | grep -acF -- "${needle}" >/dev/null && hits=$((hits + 1))
    else
      grep -aqF -- "${needle}" "${dir}/${layer}" && hits=$((hits + 1))
    fi
  done < <(node -e 'for (const l of require(process.argv[1])[0].Layers) console.log(l)' "${dir}/manifest.json")
  echo "${hits}"
}

count_in_history() {
  docker history --no-trunc --format '{{.CreatedBy}}' "$1" | grep -cF -- "$2" || true
}

count_in_config() {
  docker image inspect "$1" | grep -cF -- "$2" || true
}

# Чи є в образі shell: запуск, а не читання Dockerfile — база, успадкована від
# чужого образу, може принести sh без нашого відома.
shell_inside() {
  local sh
  for sh in sh /bin/sh /bin/bash /busybox/sh; do
    if docker run --rm --network none --entrypoint "${sh}" "$1" -c 'echo shell' >/dev/null 2>&1; then
      echo 1; return
    fi
  done
  echo 0
}

stages="$(grep -ciE '^[[:space:]]*FROM[[:space:]]' "${DOCKERFILE}")"
# CMD замінюється аргументами: ENTRYPOINT образу — node, тож це `node -e …`
# від того самого користувача, від якого стартує застосунок.
runtime_uid="$(docker run --rm --network none "${IMAGE}" -e 'process.stdout.write(String(process.getuid()))')"
size_mb="$(docker image inspect "${IMAGE}" --format '{{.Size}}' | awk '{printf "%.0f", $1/1048576}')"

echo "image=${IMAGE}"
echo "size-mb=${size_mb}"
echo "stages=${stages}"
echo "shell-inside=$(shell_inside "${IMAGE}")"
echo "runtime-uid=${runtime_uid}"
echo "token-in-history=$(count_in_history "${IMAGE}" "${TOKEN}")"
echo "token-in-config=$(count_in_config "${IMAGE}" "${TOKEN}")"
echo "token-in-layers=$(count_in_layers "${IMAGE}" "${TOKEN}" "${WORK}/main")"

if [ "${CONTROL:-0}" = "1" ]; then
  # Навмисно дірявий образ на тій самій базі: ARG→ENV (історія + конфіг) і
  # COPY файла з токеном (шар). Без shell видалити файл тут і не вийшло б.
  CTX="${WORK}/control-ctx"
  mkdir -p "${CTX}"
  cp "${TOKEN_FILE}" "${CTX}/npm_token"
  cat > "${CTX}/Dockerfile" <<'DOCKERFILE'
FROM gcr.io/distroless/nodejs24-debian12:nonroot
ARG NPM_TOKEN
ENV NPM_TOKEN=${NPM_TOKEN}
COPY npm_token /tmp/npm_token
DOCKERFILE
  CONTROL_IMAGE="marketplace-api:leaky-control"
  docker build -q --build-arg "NPM_TOKEN=${TOKEN}" -t "${CONTROL_IMAGE}" "${CTX}" >/dev/null
  echo "control-token-in-history=$(count_in_history "${CONTROL_IMAGE}" "${TOKEN}")"
  echo "control-token-in-config=$(count_in_config "${CONTROL_IMAGE}" "${TOKEN}")"
  echo "control-token-in-layers=$(count_in_layers "${CONTROL_IMAGE}" "${TOKEN}" "${WORK}/control")"
  docker image rm -f "${CONTROL_IMAGE}" >/dev/null
fi
