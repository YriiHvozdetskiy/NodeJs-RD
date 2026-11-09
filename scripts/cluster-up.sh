#!/usr/bin/env bash
# npm run cluster:up (#28) — локальний кластер kind і образ застосунку в ньому.
#
# Образ, зібраний на хості, у кластері не існує: у вузла kind свій containerd.
# Без `kind load docker-image` под висить в ErrImagePull, і imagePullPolicy:
# IfNotPresent від цього не рятує — тягнути нема звідки. Тому завантаження —
# частина цієї ж команди, і після кожного image:build її треба повторити.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CLUSTER="${KIND_CLUSTER:-marketplace}"
IMAGE="${IMAGE:-marketplace-api:hw28}"

# kind із системи, а якщо його немає — той самий kind із контейнера (scripts/lib/tools.sh).
source scripts/lib/tools.sh
KIND="$(tool_path kind)"
command -v kubectl >/dev/null || { echo "cluster:up: немає kubectl (є в Docker Desktop)" >&2; exit 1; }
docker image inspect "${IMAGE}" >/dev/null 2>&1 || { echo "cluster:up: немає образу ${IMAGE} — спершу npm run image:build" >&2; exit 1; }

# Пул адрес Docker: близько 31-ї bridge-мережі `kind create` падає з
# «all predefined address pools have been fully subnetted» — і виглядає це як
# проблема kind. Попереджаємо заздалегідь і називаємо порожні мережі поіменно
# (docker network prune — ні: знесе мережі чужих стеків).
NETS="$(docker network ls -q | wc -l | tr -d ' ')"
if [ "${NETS}" -ge 28 ]; then
  echo "⚠ мереж Docker: ${NETS}; близько 31 kind падає. Порожні:" >&2
  docker network ls --format '{{.Name}}' | while read -r n; do
    [ "$(docker network inspect "${n}" --format '{{len .Containers}}')" = "0" ] && echo "   docker network rm ${n}" >&2
  done
fi

if "${KIND}" get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  echo "кластер ${CLUSTER} уже піднятий"
else
  "${KIND}" create cluster --name "${CLUSTER}" --config k8s/kind-config.yaml --wait 120s
fi

kubectl --context "kind-${CLUSTER}" wait --for=condition=Ready node --all --timeout=120s
"${KIND}" load docker-image "${IMAGE}" --name "${CLUSTER}"

# Kubeconfig для Pulumi, що працює в контейнері: API за іменем вузла в мережі kind.
mkdir -p .kind
"${KIND}" get kubeconfig --internal --name "${CLUSTER}" > .kind/kubeconfig-internal

kubectl --context "kind-${CLUSTER}" get nodes
